import * as fetch from 'node-fetch';
import * as config from './util/config';
import HttpsProxyAgent from 'https-proxy-agent';
import {DB} from './db';
import { XummTypes } from 'xumm-sdk';
import { GenericBackendPostRequestOptions, AllowedOrigins } from './util/types';
import { Vanity } from './vanity';

export class Xumm {

    proxy = new HttpsProxyAgent(config.PROXY_URL);
    useProxy = config.USE_PROXY;
    db = new DB();
    vanity = new Vanity();

    async init() {
        await this.db.initDb("xumm");
    }

    resetDBCache() {
        this.db.resetCache();
    }

    async pingXummBackend(): Promise<boolean> {
        let pingResponse = await this.callXumm(await this.db.getAppIdForOrigin("http://localhost:4201"), "ping", "GET");
        console.log("[XUMM]: pingXummBackend response: " + JSON.stringify(pingResponse))
        return pingResponse && pingResponse.pong;
    }

    async pingBithomp(): Promise<boolean> {
        try {
            let bithompResponse:any = await fetch.default("https://bithomp.com/api/v2/services/lastUpdate", {headers: { "x-bithomp-token": config.BITHOMP_API_TOKEN }, agent: this.useProxy ? this.proxy : null});
            if(bithompResponse && bithompResponse.ok) {
                return Promise.resolve(true);
            } else {
                console.log("no ok response from bithomp");
                return Promise.resolve(false);
            }
        } catch(err) {
            console.log("error contacting bithomp API");
            return Promise.resolve(false);
        }
    }

    async submitPayload(payload:XummTypes.XummPostPayloadBodyJson, origin:string, referer: string, options?:GenericBackendPostRequestOptions): Promise<XummTypes.XummPostPayloadResponse> {
        //trying to resolve xumm user if from given frontendId:
        console.log("received payload: " + JSON.stringify(payload));
        console.log("received options: " + JSON.stringify(options));

        //check bithomp api in case of payment and do not proceed if inaccessible
        try {
            if(payload && payload.txjson && payload.txjson.TransactionType && "payment" === payload.txjson.TransactionType.toLowerCase() && payload.custom_meta && payload.custom_meta.instruction && "Thank you for your donation!" != payload.custom_meta.instruction) {
                let bithompAvailable = await this.pingBithomp();
                if(!bithompAvailable)
                    return Promise.reject("bithomp");
            }
        } catch(err) {
            console.log("error checking bithomp")
            return Promise.reject("bithomp");
        }

        
        let xrplAccount:string;
        let pushDisabled:boolean = options && options.pushDisabled;
        let appId = await this.db.getAppIdForOrigin(origin);

        if(!appId)
            return {uuid: "error", next: null, refs: null, pushed: null};
        
        if(options && options.referer) {
            referer = options.referer;
        }

        try {
            //get xummId by xrplAccount
            if(options && (xrplAccount = options.xrplAccount) && !payload.user_token) {

                //resolve xummId by XrplAccount
                let xummIdForXrplAccount:string = await this.db.getXummIdForXRPLAccount(appId, xrplAccount);
                if(xummIdForXrplAccount)
                    payload.user_token = xummIdForXrplAccount;
                
                if(!payload.user_token) {
                    //resolve xummId by latest sign in payload
                    console.log("getting xummId by xplAccount: " + xrplAccount);
                    let appId:string = await this.db.getAppIdForOrigin(origin)
                    let payloadIds:string[] = await this.db.getPayloadIdsByXrplAccountForApplicationBySignin(appId, xrplAccount);
                    console.log("payloadIds: " + JSON.stringify(payloadIds));

                    if(payloadIds && payloadIds.length > 0) {
                        let latestPayloadInfo:XummTypes.XummGetPayloadResponse = await this.getPayloadInfoByAppId(appId, payloadIds[payloadIds.length-1]);
                        console.log("latestPayloadInfo: " + JSON.stringify(latestPayloadInfo));
                        if(latestPayloadInfo && latestPayloadInfo.application && latestPayloadInfo.application.issued_user_token)
                            payload.user_token = latestPayloadInfo.application.issued_user_token;
                    }

                    //no SignIn found or SignIn did not have issued user token
                    if(!payload.user_token) {
                        //try getting issued_user_token by type!
                        payloadIds = await this.db.getPayloadIdsByXrplAccountForApplicationAndType(appId, xrplAccount, payload.txjson.TransactionType);

                        if(payloadIds && payloadIds.length > 0) {
                            let latestPayloadInfo:XummTypes.XummGetPayloadResponse = await this.getPayloadInfoByAppId(appId, payloadIds[payloadIds.length-1]);
                            //console.log("latestPayloadInfo: " + JSON.stringify(latestPayloadInfo));
                            if(latestPayloadInfo && latestPayloadInfo.application && latestPayloadInfo.application.issued_user_token)
                                payload.user_token = latestPayloadInfo.application.issued_user_token;
                        }
                    }
                }
            }

            payload = await this.adaptOriginProperties(origin, appId, payload, referer, options);
            
        } catch(err) {
            console.log("err creating payload request")
            console.log(JSON.stringify(err));

            throw "err creating payload request";
        }

        console.log("[XUMM]: payload to send:" + JSON.stringify(payload));
        let payloadResponse:XummTypes.XummPostPayloadResponse = await this.callXumm(appId, "payload", "POST", payload);
        console.log("[XUMM]: submitPayload response: " + JSON.stringify(payloadResponse))

        //don't block the response
        setTimeout(() => { this.storePayloadInfo(origin, referer,  appId, payload, payloadResponse) },2000);
        
        return payloadResponse;
    }

    async storePayloadInfo(origin:string, referer: string, appId: string, payload: XummTypes.XummPostPayloadBodyJson, payloadResponse: XummTypes.XummPostPayloadResponse) {
        try {
            let payloadInfo:XummTypes.XummGetPayloadResponse = await this.getPayloadInfoByAppId(appId, payloadResponse.uuid);
            this.db.saveTempInfo({origin: origin, referer: referer, applicationId: appId, xummUserId: payload.user_token, payloadId: payloadResponse.uuid, expires: payloadInfo.payload.expires_at});
        } catch(err) {
            console.log("Error saving TempInfo");
            console.log(JSON.stringify(err));
        }
    }

    async getPayloadInfoByOrigin(origin:string, payload_id:string): Promise<XummTypes.XummGetPayloadResponse> {
        let appId:string = await this.db.getAppIdForOrigin(origin);
        if(!appId)
            return null;

        return this.getPayloadInfoByAppId(appId, payload_id);
    }

    async getPayloadInfoByAppId(applicationId:string, payload_id:string): Promise<XummTypes.XummGetPayloadResponse> {
        let payloadResponse:XummTypes.XummGetPayloadResponse = await this.callXumm(applicationId, "payload/"+payload_id, "GET");
        //console.log("getPayloadInfo response: " + JSON.stringify(payloadResponse))
        return payloadResponse;
    }

    async deletePayload(origin: string, payload_id:string): Promise<XummTypes.XummDeletePayloadResponse> {
        let appId:string = await this.db.getAppIdForOrigin(origin);
        if(!appId)
            return null;

        let payloadResponse = await this.callXumm(appId, "payload/"+payload_id, "DELETE");
        //console.log("deletePayload response: " + JSON.stringify(payloadResponse))
        return payloadResponse;
    }

    async getxAppOTT(origin: string, token: string): Promise<any> {
        let appId:string = await this.db.getAppIdForOrigin(origin);
        if(!appId)
            return null;

        let ottData = await this.callXumm(appId, "xapp/ott/"+token, "GET");
        console.log("getxAppOTT response: " + JSON.stringify(ottData))
        return ottData;
    }

    async sendxAppEvent(origin: string, data: any): Promise<any> {
        let appId:string = await this.db.getAppIdForOrigin(origin);
        if(!appId)
            return null;

        let xappEventResponse = await this.callXumm(appId, "xapp/event", "POST", data);
        console.log("sendxAppEvent response: " + JSON.stringify(xappEventResponse))
        return xappEventResponse;
    }

    async sendxAppPush(origin: string, data: any): Promise<any> {
        let appId:string = await this.db.getAppIdForOrigin(origin);
        if(!appId)
            return null;

        let xappPushResponse = await this.callXumm(appId, "xapp/push", "POST", data);
        console.log("sendxAppPush response: " + JSON.stringify(xappPushResponse))
        return xappPushResponse;
    }

    async callXumm(applicationId:string, path:string, method:string, body?:any): Promise<any> {
        try {
            let appSecret:string = await this.db.getApiSecretForAppId(applicationId);
            if(appSecret) {
                //console.log("[XUMM]: applicationId: " + applicationId);
                //console.log("[XUMM]: appSecret: " + appSecret);
                console.log("[XUMM]: calling xumm: " + method + " - " + config.XUMM_API_URL+path);
                //console.log("[XUMM]: with body: " + JSON.stringify(body));
                let xummResponse = await fetch.default(config.XUMM_API_URL+path,
                    {
                        headers: {
                            "Content-Type": "application/json",
                            "x-api-key": applicationId,
                            "x-api-secret": appSecret
                        },
                        agent: this.useProxy ? this.proxy : null,
                        method: method,
                        body: (body ? JSON.stringify(body) : null)
                    },
                );

                if(xummResponse)
                    return xummResponse.json();
                else
                    return null;
            } else {
                console.log("Could not find api keys for applicationId: " + applicationId);
                return null;
            }
        } catch(err) {
            console.log("err calling xumm");
            console.log(JSON.stringify(err));
        }
    }

    async adaptOriginProperties(origin: string, appId: string, payload: XummTypes.XummPostPayloadBodyJson, referer: string, options: GenericBackendPostRequestOptions): Promise<XummTypes.XummPostPayloadBodyJson> {
        let originProperties:AllowedOrigins = await this.db.getOriginProperties(appId);
        //console.log("[XUMM]: originProperties: " + JSON.stringify(originProperties));

        //for payments -> set destination account in backend
        if(payload.txjson && payload.txjson.TransactionType && payload.txjson.TransactionType.trim().toLowerCase() === 'payment') {

            let vanityData:any = payload.custom_meta.blob;

            if(vanityData.isPurchase && originProperties.destinationAccount) {
                if(originProperties.destinationAccount[referer]) {
                    payload.txjson.Destination = originProperties.destinationAccount[referer].account;
                    if(originProperties.destinationAccount[referer].tag && Number.isInteger(originProperties.destinationAccount[referer].tag))
                        payload.txjson.DestinationTag = originProperties.destinationAccount[referer].tag;
                    else
                        delete payload.txjson.DestinationTag;

                } else if(originProperties.destinationAccount[origin+'/*']) {
                    payload.txjson.Destination = originProperties.destinationAccount[origin+'/*'].account;
                    if(originProperties.destinationAccount[origin+'/*'].tag && Number.isInteger(originProperties.destinationAccount[origin+'/*'].tag))
                        payload.txjson.DestinationTag = originProperties.destinationAccount[origin+'/*'].tag;
                    else
                        delete payload.txjson.DestinationTag;

                } else if(originProperties.destinationAccount['*']) {
                    payload.txjson.Destination = originProperties.destinationAccount['*'].account;
                    if(originProperties.destinationAccount['*'].tag && Number.isInteger(originProperties.destinationAccount['*'].tag))
                        payload.txjson.DestinationTag = originProperties.destinationAccount['*'].tag;
                    else
                        delete payload.txjson.DestinationTag;
                }
            } else if(vanityData.isActivation) {
                //we are activation. set the vanity address as destination account!
                payload.txjson.Destination = vanityData.vanityAddress;
            }
            
            if(vanityData.isPurchase && originProperties.fixAmount) {
                console.log("calculating fix amount");
                let usdAmount = -1;
                let vanityData:any = payload.custom_meta.blob;
                let vanityLength:string = vanityData.vanityLength;

                if(originProperties.fixAmount[vanityLength]) {
                    usdAmount = originProperties.fixAmount[vanityLength];
                    console.log("usdAmount: " + usdAmount);
                    payload.txjson.Amount = await this.vanity.convertUSDtoXRP(usdAmount);

                } else {
                    throw "Invalid amount or vanity length";
                }
            } else if(vanityData.isActivation) {
                payload.txjson.Amount = "20001000";
            } else {
                //something weired happened.
                throw "Invalid data, can not create Amount field";
            }

            console.log("payload.txjson.Amount: " + JSON.stringify(payload.txjson.Amount));
        }

        return payload;
    }
}
