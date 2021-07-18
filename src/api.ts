import * as Xumm from './xumm';
import * as Db from './db';
import * as Special from './special';
import * as Vanity from './vanity';
import consoleStamp = require("console-stamp");
import { XummTypes } from 'xumm-sdk';
import DeviceDetector = require("device-detector-js");
import { AddressAndSecret, AddressResult, TransactionValidation } from './util/types';
import * as crypto from 'crypto';

consoleStamp(console, { pattern: 'yyyy-mm-dd HH:MM:ss' });

let xummBackend = new Xumm.Xumm();
let db = new Db.DB();
let special = new Special.Special();
let vanity = new Vanity.Vanity();
let deviceDetector = new DeviceDetector();

export async function registerRoutes(fastify, opts, next) {
    await xummBackend.init();
    await db.initDb("api");
    await special.init();
    
    fastify.post('/api/v1/search', async (request, reply) => {
        console.log("post payload headers: " + JSON.stringify(request.headers));
        //console.log("body: " + JSON.stringify(request.body));
        if(!request.headers['x-hash'])
            reply.code(500).send('You are not allowed');
        else {
            //try parsing the' user agent when unknown to determine if web or app
            try {
                //check x-hash header
                let vanitySearchString:string = JSON.stringify(request.body.search);
                let xHash:string = crypto.createHash('sha256').update("secret"+vanityAccount+config.VANITY_BACKEND_SECRET).digest("hex");
                try {
                    if(request.body && request.body.options && (request.body.options.web == null || request.body.options.web == undefined)) {
                        let parseResult = deviceDetector.parse(request.headers['user-agent'])
                        if(parseResult && parseResult.device && parseResult.device.type) {
                            request.body.options.web = 'desktop' === parseResult.device.type;
                        }
                    }
                } catch(err) {
                    console.log("failed to parse user agent");
                    console.log(JSON.stringify(err));
                }

                let refererURL:string = request.headers.referer;
                if(refererURL && refererURL.includes('?')) {
                    refererURL = refererURL.substring(0, refererURL.indexOf('?'));
                }

                let payloadResponse = await xummBackend.submitPayload(request.body.payload, request.headers.origin, refererURL, request.body.options);
                return payloadResponse;
            } catch (err) {
                if('bithomp' == err) {
                    return { success : false, error: true, message: "We can not contact our XRP Ledger service provider and therefore won't be able to to verify your transaction. Please try again later!"};
                }
                else
                    return { success : false, error: true, message: 'Something went wrong. Please check your request'};
                }
        }
    });

    fastify.get('/api/v1/platform/payload/:id', async (request, reply) => {
        //console.log("request params: " + JSON.stringify(request.params));
        if(!request.params.id) {
            reply.code(500).send('Please provide a payload id. Calls without payload id are not allowed');
        } else {
            try {
                return xummBackend.getPayloadInfoByOrigin(request.headers.origin, request.params.id);
            } catch {
                return { success : false, error: true, message: 'Something went wrong. Please check your request'};
            }
        }
    });

    fastify.delete('/api/v1/platform/payload/:id', async (request, reply) => {
        //console.log("request params: " + JSON.stringify(request.params));
        if(!request.params.id) {
            reply.code(500).send('Please provide a payload id. Calls without payload id are not allowed');
        } else {
            try {
                return xummBackend.deletePayload(request.headers.origin, request.params.id);
            } catch {
                return { success : false, error: true, message: 'Something went wrong. Please check your request'};
            }
        }
    });

    fastify.get('/api/v1/platform/xapp/ott/:token', async (request, reply) => {
        //console.log("request params: " + JSON.stringify(request.params));
        if(!request.params.token) {
            reply.code(500).send('Please provide a token. Calls without token are not allowed');
        } else {
            try {
                return xummBackend.getxAppOTT(request.headers.origin, request.params.token);
            } catch {
                return { success : false, error: true, message: 'Something went wrong. Please check your request'};
            }
        }
    });

    fastify.post('/api/v1/platform/xapp/event', async (request, reply) => {
        console.log("post xApp event headers: " + JSON.stringify(request.headers));
        //console.log("body: " + JSON.stringify(request.body));
        if(!request.body.user_token || !request.body.subtitle)
            reply.code(500).send('Please provide a xumm user_token and subtitle. Calls without xumm user_token and subtitle are not allowed');
        else {
            //try parsing the user agent when unknown to determine if web or app
            try {
                let payloadResponse = await xummBackend.sendxAppEvent(request.headers.origin, request.body);
                return payloadResponse;
            } catch (err) {
                return { success : false, error: true, message: 'Something went wrong. Please check your request'};
            }
        }
    });

    fastify.post('/api/v1/platform/xapp/push', async (request, reply) => {
        console.log("post xApp push headers: " + JSON.stringify(request.headers));
        //console.log("body: " + JSON.stringify(request.body));
        if(!request.body.user_token || !request.body.subtitle)
            reply.code(500).send('Please provide a xumm user_token and subtitle. Calls without xumm user_token and subtitle are not allowed');
        else {
            //try parsing the user agent when unknown to determine if web or app
            try {
                let payloadResponse = await xummBackend.sendxAppPush(request.headers.origin, request.body);
                return payloadResponse;
            } catch (err) {
                return { success : false, error: true, message: 'Something went wrong. Please check your request'};
            }
        }
    });


    fastify.get('/api/v1/check/payment/:payloadId', async (request, reply) => {
        //console.log("request params: " + JSON.stringify(request.params));
        if(!request.params.payloadId) {
            reply.code(500).send('Please provide a payload id. Calls without payload id are not allowed');
        } else {
            try {
                let payloadInfo:XummTypes.XummGetPayloadResponse = await xummBackend.getPayloadInfoByOrigin(request.headers.origin, request.params.payloadId);

                if(payloadInfo && special.successfullPaymentPayloadValidation(payloadInfo)) {
                    let validation = await special.validatePaymentOnLedger(payloadInfo.response.txid, payloadInfo);
                    
                    return validation;
                }

                //we didn't go into the success:true -> so return false :)
                return {success : false}
                
            } catch {
                return { success : false, error: true, message: 'Something went wrong. Please check your request'};
            }
        }
    });

    fastify.get('/api/v1/check/signin/:payloadId', async (request, reply) => {
        //console.log("request params: " + JSON.stringify(request.params));
        if(!request.params.payloadId)
            reply.code(500).send('Please provide a payload id. Calls without payload id are not allowed');
        else {
            try {
                let payloadInfo:XummTypes.XummGetPayloadResponse = await xummBackend.getPayloadInfoByOrigin(request.headers.origin,request.params.payloadId);

                if(payloadInfo && special.successfullSignInPayloadValidation(payloadInfo)) {
                    return {success: true, account: payloadInfo.response.account}
                }
                
                //we didn't go into the success:true -> so return false :)
                return {success : false, account: payloadInfo.response.account }

            } catch {
                return { success : false, error: true, message: 'Something went wrong. Please check your request'};
            }
        }
    });

    fastify.get('/api/v1/xrpl/validatetx/:payloadId', async (request, reply) => {
        //console.log("request params: " + JSON.stringify(request.params));
        if(!request.params.payloadId) {
            reply.code(500).send('Please provide a payload id. Calls without payload id are not allowed');
        } else {
            try {
                let payloadInfo:XummTypes.XummGetPayloadResponse = await xummBackend.getPayloadInfoByOrigin(request.headers.origin, request.params.payloadId)

                console.log(JSON.stringify(payloadInfo));
                if(payloadInfo && payloadInfo.response && payloadInfo.response.txid) {
                    let txResult = await special.validateXRPLTransaction(payloadInfo.response.txid);
                    if(txResult)
                        txResult.account = payloadInfo.response.account;

                    return txResult;
                }
                
                //we didn't go into the success:true -> so return false :)
                return {success : false, testnet: false, account: payloadInfo.response.account }

            } catch {
                return { success : false, error: true, message: 'Something went wrong. Please check your request'};
            }
        }
    });

    fastify.get('/api/v1/vanity/search/:searchWord', async (request, reply) => {
        //console.log("request params: " + JSON.stringify(request.params));
        if(!request.params.searchWord) {
            reply.code(500).send('Please provide a word to search for. Calls without search word are not allowed');
        } else {
            try {
                let searchResult:AddressResult = await vanity.searchForVanityAddress(request.params.searchWord);
                let alreadyBought = await db.getAllPurchasedVanityAddress();

                console.log("alreadyBought addresses: " + JSON.stringify(alreadyBought));

                if(alreadyBought && alreadyBought.length > 0 && searchResult && searchResult.addresses && searchResult.addresses.length > 0) {
                    //check
                    console.log("checking search result: " + JSON.stringify(searchResult));
                    searchResult.addresses = searchResult.addresses.filter(address => !alreadyBought.includes(address));
                    console.log("returning search result: " + JSON.stringify(searchResult));
                    return searchResult;
                } else {
                    //nothing to check
                    return searchResult;
                }
            } catch {
                return { success : false, error: true, message: 'Something went wrong. Please check your request'};
            }
        }
    });

    fastify.get('/api/v1/vanity/purchased/:account', async (request, reply) => {
        //console.log("request params: " + JSON.stringify(request.params));
        if(!request.params.account) {
            reply.code(500).send('Please provide a account to get the purchases for. Calls without account are not allowed');
        } else {
            try {
                let alreadyBought = await db.getPurchasedVanityAddress(request.params.account);

                if(alreadyBought) {
                    return { addresses: alreadyBought };
                } else {
                    return { addresses: [] };
                }
            } catch {
                return { success : false, error: true, message: 'Something went wrong. Please check your request'};
            }
        }
    });

    fastify.get('/api/v1/statistics/transactions', async (request, reply) => {
        
        try {
            let origin = request && request.query && request.query.origin ? request.query.origin : request.headers.origin;
            let appId = await db.getAppIdForOrigin(origin);
            let transactionStats:any = await db.getTransactions(origin, appId);
            return transactionStats;                
        } catch {
            return { success : false, error: true, message: 'Something went wrong. Please check your request'};
        }
    });

    fastify.get('/api/v1/properties/amounts', async (request, reply) => {
        
        try {
            let origin = request && request.query && request.query.origin ? request.query.origin : request.headers.origin;
            let appId = await db.getAppIdForOrigin(origin);
            let originProperties:any = await db.getOriginProperties(appId);
            console.log("fix amount: " + JSON.stringify(originProperties.fixAmount));
            return originProperties.fixAmount;                
        } catch {
            return { success : false, error: true, message: 'Something went wrong. Please check your request'};
        }
    });

    fastify.post('/api/v1/webhook', async (request, reply) => {
        return handleWebhookRequest(request);
    });

    fastify.post('/api/v1/webhook/*', async (request, reply) => {
        return handleWebhookRequest(request);
    });

    next()
}

async function handleWebhookRequest(request:any): Promise<any> {
    console.log("webhook headers: " + JSON.stringify(request.headers));
    //console.log("webhook body: " + JSON.stringify(request.body));
    
    try {
        let webhookRequest:XummTypes.XummWebhookBody = request.body;
        let payloadInfo:XummTypes.XummGetPayloadResponse = await xummBackend.getPayloadInfoByAppId(webhookRequest.meta.application_uuidv4, webhookRequest.meta.payload_uuidv4);
        
        //check if we have to store the user
        try {
            let tmpInfo:any = await db.getTempInfo({payloadId: payloadInfo.meta.uuid, applicationId: payloadInfo.application.uuidv4});
            let origin:string = tmpInfo ? tmpInfo.origin : null;

            //store transaction statistic
            //check if payload was signed and submitted successfully (or is a SignIn request which is not submitted)
            if(payloadInfo && payloadInfo.meta.signed && origin && ((payloadInfo.response && payloadInfo.response.dispatched_result && payloadInfo.response.dispatched_result == "tesSUCCESS") || ( payloadInfo.payload && payloadInfo.payload.tx_type && payloadInfo.payload.tx_type.toLowerCase() == "signin" ))) {
                db.saveTransactionInStatistic(origin, payloadInfo.application.uuidv4, payloadInfo.payload.tx_type);
            }

            //check escrow payment
            if(payloadInfo && payloadInfo.payload && payloadInfo.payload.tx_type && payloadInfo.payload.tx_type.toLowerCase() == 'payment' && payloadInfo.custom_meta && payloadInfo.custom_meta.blob) {
                let blobInfo:any = payloadInfo.custom_meta.blob;

                if(blobInfo.vanityAddress) {
                    if(blobInfo.isPurchase) {
                        handleVanityPayment(payloadInfo, origin)
                    } else if(blobInfo.isActivation) {
                        handleVanityActivation(payloadInfo);
                    } else {
                        //what happens here?
                        console.log("WE SHOULD NOT GO HERE");
                    }
                }
            }

            if(tmpInfo) {
                if(payloadInfo && payloadInfo.application && payloadInfo.application.issued_user_token) {
                    await db.saveUser(origin, payloadInfo.application.uuidv4, tmpInfo.frontendId, payloadInfo.application.issued_user_token);
                    await db.storePayloadForXummId(origin, tmpInfo.referer, payloadInfo.application.uuidv4, payloadInfo.application.issued_user_token, payloadInfo.meta.uuid, payloadInfo.payload.tx_type);
                }

                //store payload to XRPL account
                if(payloadInfo && payloadInfo.response && payloadInfo.response.account) {
                    await db.storePayloadForXRPLAccount(origin, tmpInfo.referer, payloadInfo.application.uuidv4, payloadInfo.response.account, webhookRequest.userToken.user_token, payloadInfo.meta.uuid, payloadInfo.payload.tx_type);
                }

                await db.deleteTempInfo(tmpInfo);

                return {success: true}
            } else {
                return {success: false}
            }
        } catch {
            return { success : false, error: true, message: 'Something went wrong. Please check your request'};
        }
    } catch {
        return { success : false, error: true, message: 'Something went wrong. Please check your request'};
    }
}

async function handleVanityPayment(payloadInfo: XummTypes.XummGetPayloadResponse, origin: string) {
    //user has paid for this address. Add it to the users purchased addresses in the DB so it is reserved
    if(payloadInfo && special.successfullPaymentPayloadValidation(payloadInfo)) {
        let txResult:TransactionValidation = await special.validatePaymentOnLedger(payloadInfo.response.txid, payloadInfo);

        console.log("handleVanityPayment TXRESULT: " + JSON.stringify(txResult));

        if(txResult) {
            if(payloadInfo.custom_meta.blob) {
                txResult.account = payloadInfo.response.account;
                let vanityObject:any = payloadInfo.custom_meta.blob;
                let vanityAddress:string = vanityObject ? vanityObject.vanityAddress : null;

                console.log("handleVanityPayment ADDRESS: " + vanityAddress);

                //if(vanityAddress && txResult.success && txResult.testnet == false) { <---- USE THIS WHEN IN PROD!!!
                if(vanityAddress && txResult.success) {
                    let buyerAccount: string = payloadInfo.response.account;
                    let vanityBlob:any = payloadInfo.custom_meta.blob;
                    if(buyerAccount && vanityBlob.vanityAddress)
                        db.storeVanityPurchase(origin, await db.getAppIdForOrigin(origin), buyerAccount, vanityBlob.vanityAddress);
                }
            }
        }
    }
}

async function handleVanityActivation(payloadInfo: XummTypes.XummGetPayloadResponse) {
    console.log("handleVanityActivation PAYLOAD: " + JSON.stringify(payloadInfo));

    if(payloadInfo && special.successfullPaymentPayloadValidation(payloadInfo)) {
        let txResult:TransactionValidation = await special.validatePaymentOnLedger(payloadInfo.response.txid, payloadInfo);

        console.log("handleVanityActivation TXRESULT: " + JSON.stringify(txResult));

        if(txResult) {
            if(payloadInfo.custom_meta.blob) {
                txResult.account = payloadInfo.response.account;
                let vanityObject:any = payloadInfo.custom_meta.blob;
                let vanityAddress:string = vanityObject ? vanityObject.vanityAddress : null;

                console.log("handleVanityActivation ADDRESS: " + vanityAddress);

                //if(vanityAddress && txResult.success && txResult.testnet == false) { <---- USE THIS WHEN IN PROD!!!
                if(vanityAddress && txResult.success) {
                    //retrieve family seed
                    let vanityAccount:AddressAndSecret = await vanity.getSecretForVanityAddress(vanityAddress);
                    //rekey account.
                    let regularKeyResult:TransactionValidation = await vanity.rekeyVanityAccount(vanityAddress, vanityAccount.vanitySecret, payloadInfo.response.account);
                    if(regularKeyResult.success && regularKeyResult.txid) {
                        //timeout to wait for validated ledger
                        setTimeout(async () => {
                            //regular key tx was submitted, check for result!
                            let regularKeySubmitResult:TransactionValidation = await special.validateXRPLTransaction(regularKeyResult.txid);
                            if(regularKeySubmitResult && regularKeySubmitResult.txid == regularKeyResult.txid) {
                                let disableMasterKeyResult = await vanity.disableMasterKey(vanityAddress, vanityAccount.vanitySecret);
                                if(disableMasterKeyResult.success) {
                                    console.log("vanity address " + vanityAddress + " successfully transfered. Deleting it from database.");
                                    console.log("deleting vanity address result: " + (await vanity.purgeVanityAddress(vanityAddress)));
                                } else {
                                    console.log("could not disable master key for vanity account: " +vanityAddress);
                                }
                            } else {
                                console.log("vanity account " + vanityAddress + " could not be rekeyed (transaction could not be found on ledger)")
                            }
                        }, 4000);
                        
                    } else {
                        console.log("regular key could not be changed for vanity address " + vanityAddress)
                    }
                } else {
                    console.log("Vanity payment not successfull or vanity account not found");
                }
            } else {
                console.log("The transaction does not have the vanity address attached!")
            }
        } else {
            console.log("Transaction could not be verified!");
        }
    }
}

