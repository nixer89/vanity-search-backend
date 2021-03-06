import * as Xumm from './xumm';
import * as DB from './db';
import * as apiRoute from './api';
import * as config from './util/config';
import * as scheduler from 'node-schedule';

const fastify = require('fastify')({
  trustProxy: config.USE_PROXY,
  //logger: {
    //level: 'warn',
  //  level: 'info',
  //  file: '/home/ubuntu/fastify-logs/fastify.log' // Will use pino.destination()
  //}
});

import consoleStamp = require("console-stamp");
consoleStamp(console, { pattern: 'yyyy-mm-dd HH:MM:ss' });

console.log("adding response compression");
fastify.register(require('fastify-compress'));

console.log("adding some security headers");
fastify.register(require('fastify-helmet'));

let mongo = new DB.DB();
let xummBackend:Xumm.Xumm = new Xumm.Xumm();
let allowedOrigins:string[];

// Run the server!
const start = async () => {
    if(!config.BITHOMP_API_TOKEN) {
      console.log("No BITHOMP_API_TOKEN set");
      process.exit(1);
    }

    console.log("starting server");
    try {
      //init routes
      
      await mongo.initDb("server");
      await mongo.ensureIndexes()

      console.log("adding cors");
      allowedOrigins = await mongo.getAllowedOriginsAsArray();

      console.log("setting allowed origins: " + allowedOrigins);
      fastify.register(require('fastify-cors'), {
        origin: (origin, cb) => {

          //console.log("checking request with origin: " + origin);
          if(!origin) {
            // Requests will pass - if origin is needed will be checked later
            cb(null, true);
            return;
          }

          if(allowedOrigins) {
            if(allowedOrigins.includes(origin)) {
              // Requests will pass
              cb(null, true);
              return;
            }

            for(let i = 0; i < allowedOrigins.length; i++) {
              if(new RegExp(allowedOrigins[i]).test(origin)) {
                // Request will pass
                cb(null, true)
                return
              }
            }
          }

          
          
          cb(new Error("Origin not allowed"), false);
        },
        methods: 'GET, POST, DELETE, OPTIONS',
        allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'Referer']
      });
      
      fastify.addHook('onRequest', (request, reply, done) => {
        if(request.raw.url != '/' &&
            !(request.raw.url === '/api/v1/webhook'))
        {
          if(!request.headers.origin)
            reply.code(500).send('Please provide an origin header. Calls without origin are not allowed');
          else
            done()
        } else {
          done()
        }
      });
      
      await xummBackend.init();

      if(await xummBackend.pingXummBackend()) {

        console.log("declaring 200er reponse")
        fastify.get('/', async (request, reply) => {
          reply.code(200).send('I am alive!'); 
        });

        console.log("declaring routes");
        fastify.register(apiRoute.registerRoutes);
        console.log("finished declaring routes");

        try {
          await fastify.listen(4001, '0.0.0.0');

          console.log("http://localhost:4001/");

          fastify.ready(err => {
            if (err) throw err
        });
        } catch(err) {
          console.log('Error starting server:', err)
        }

        scheduler.scheduleJob("tmpInfoTableCleanup", {minute: 5}, () => cleanupTmpInfoTable());

      } else {
          console.log("Xumm backend not available");
          process.exit(1);
      }
    } catch (err) {
      fastify.log.error(err);
      process.exit(1);
    }
}

async function cleanupTmpInfoTable() {
  //console.log("cleaning up cleanupTmpInfoTable")
  //get all temp info documents
  let tmpInfoEntries:any[] = await mongo.getAllTempInfo();
  console.log("cleanup having entries: " + tmpInfoEntries.length);
  for(let i = 0; i < tmpInfoEntries.length; i++) {
    let expirationDate:Date = new Date(tmpInfoEntries[i].expires);
    //add 10 days to expiration date to make sure payload is not used anymore
    expirationDate.setDate(expirationDate.getDate()+10);
    //payload is expired. Check if user has opened it
    if(Date.now() > expirationDate.getTime()) {
      //console.log("checking entry: " + JSON.stringify(tmpInfoEntries[i]));
      await mongo.deleteTempInfo(tmpInfoEntries[i]);
    }
  }
}

console.log("running server");
start();