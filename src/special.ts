import * as Xumm from './xumm';
import * as DB from './db';
import * as config from './util/config'
import HttpsProxyAgent from 'https-proxy-agent';
import * as fetch from 'node-fetch';
import {verifySignature} from 'verify-xrpl-signature'
import { XummTypes } from 'xumm-sdk';
import { TransactionValidation } from './util/types';

export class Special {
    private proxy = new HttpsProxyAgent(config.PROXY_URL);
    private useProxy = config.USE_PROXY;
    private xummBackend = new Xumm.Xumm();
    private db = new DB.DB();

    async init() {
        await this.xummBackend.init();
        await this.db.initDb("special");
    }

    resetDBCache() {
        this.db.resetCache();
        this.xummBackend.resetDBCache();
    }
    
    basicPayloadInfoValidation(payloadInfo: XummTypes.XummGetPayloadResponse): boolean {
        return payloadInfo && payloadInfo.meta && payloadInfo.payload && payloadInfo.response
            && payloadInfo.meta.exists && payloadInfo.meta.resolved && payloadInfo.meta.signed;
    }
    
    successfullPaymentPayloadValidation(payloadInfo: XummTypes.XummGetPayloadResponse): boolean {
        if(this.basicPayloadInfoValidation(payloadInfo) && 'payment' === payloadInfo.payload.tx_type.toLowerCase() && payloadInfo.meta.submit && payloadInfo.response.dispatched_result === 'tesSUCCESS') {
            //validate signature
            return verifySignature(payloadInfo.response.hex).signatureValid
        } else {
            return false;
        }
    }
    
    successfullSignInPayloadValidation(payloadInfo: XummTypes.XummGetPayloadResponse): boolean {
        if(this.basicPayloadInfoValidation(payloadInfo) && 'signin' === payloadInfo.payload.tx_type.toLowerCase() && payloadInfo.response.txid && payloadInfo.response.hex && payloadInfo.response.account) {
            //validate signature
            return verifySignature(payloadInfo.response.hex).signatureValid;
        } else {
            return false;
        }
    }

    async validateXRPLTransaction(txid: string): Promise<TransactionValidation> {
        if(await this.callBithompAndValidate(txid, false)) {
            return {
                success: true,
                testnet: false,
                txid: txid
            };
        } else if (await this.callBithompAndValidate(txid, true)) {
            return {
                success: true,
                testnet: true,
                txid: txid
            };
        } else {
            return {
                success: false,
                testnet: false
            };
        }
    }

    async validatePaymentOnLedger(trxHash:string, payloadInfo: XummTypes.XummGetPayloadResponse): Promise<TransactionValidation> {
        let destinationAccount:any = {
            account: payloadInfo.payload.request_json.Destination,
            tag: payloadInfo.payload.request_json.DestinationTag,
        }
        
        if(trxHash && destinationAccount) {
            if(await this.callBithompAndValidate(trxHash, false, destinationAccount, payloadInfo.payload.request_json.Amount)) {
                return {
                    success: true,
                    testnet: false,
                    txid: trxHash,
                    account: payloadInfo.response.account
                }
            } else if (await this.callBithompAndValidate(trxHash, true, destinationAccount, payloadInfo.payload.request_json.Amount)) {
                return {
                    success: true,
                    testnet: true,
                    txid: trxHash,
                    account: payloadInfo.response.account
                }
            }

            return {
                success: false,
                testnet: false,
                account: payloadInfo.response.account
            }

        } else {
            return {
                success: false,
                testnet: false,
                account: payloadInfo.response.account
            };
        }
    }

    async callBithompAndValidate(trxHash:string, testnet: boolean, destinationAccount?:any, amount?:any): Promise<boolean> {
        try {
            console.log("checking bithomp with trxHash: " + trxHash);
            console.log("checking bithomp with testnet: " + testnet + " - destination account: " + JSON.stringify(destinationAccount) + " - amount: " + JSON.stringify(amount));
            let bithompResponse:any = await fetch.default("https://"+(testnet?'test.':'')+"bithomp.com/api/v2/transaction/"+trxHash, {headers: { "x-bithomp-token": config.BITHOMP_API_TOKEN },agent: this.useProxy ? this.proxy : null});
            if(bithompResponse && bithompResponse.ok) {
                let ledgerTrx:any = await bithompResponse.json();
                console.log("got ledger transaction from " + (testnet? "testnet:": "livenet:") + JSON.stringify(ledgerTrx));

                //standard validation of successfull transaction
                if(ledgerTrx && ledgerTrx.type && ledgerTrx.type.toLowerCase() === 'payment'
                    && ledgerTrx.specification && ledgerTrx.specification.destination && (destinationAccount ? ledgerTrx.specification.destination.address === destinationAccount.account : true)
                        && (destinationAccount && destinationAccount.tag ? ledgerTrx.specification.destination.tag == destinationAccount.tag : true) && ledgerTrx.outcome  && ledgerTrx.outcome.result === 'tesSUCCESS') {

                            if(!amount) {
                                //no amount in request. Accept any amount then
                                return true;
                            }
                            //validate delivered amount
                            else if(Number.isInteger(parseInt(amount))) {
                                //handle XRP amount
                                return ledgerTrx.outcome.deliveredAmount.currency === 'XRP' && (parseFloat(ledgerTrx.outcome.deliveredAmount.value)*1000000 == parseInt(amount));
                            } else {
                                //amount not a number so it must be a IOU
                                return ledgerTrx.outcome.deliveredAmount.currency === amount.currency //check currency
                                    && ledgerTrx.outcome.deliveredAmount.counterparty === amount.issuer //check issuer
                                        && ledgerTrx.outcome.deliveredAmount.value === amount.value; //check value
                            }

                } else if( ledgerTrx && ledgerTrx.outcome  && ledgerTrx.outcome.result === 'tesSUCCESS') {
                    return true;
                } else {
                    //transaction not valid
                    return false;
                }
            } else {
                return false;
            }
        } catch(err) {
            console.log("ERR validating with bithomp");
            console.log(JSON.stringify(err));
        }
    }
}