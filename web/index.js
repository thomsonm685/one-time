// @ts-check
import 'dotenv/config';
import { join } from "path";
import fs from "fs";
import express from "express";
import cookieParser from "cookie-parser";
import { Shopify, LATEST_API_VERSION } from "@shopify/shopify-api";
import bodyParser from 'body-parser'; 
import cors from 'cors';
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from 'uuid';
import applyAuthMiddleware from "./middleware/auth.js";
import verifyRequest from "./middleware/verify-request.js";
import { setupGDPRWebHooks } from "./gdpr.js"; 
import productCreator from "./helpers/product-creator.js";
import { BillingInterval } from "./helpers/ensure-billing.js";
import { AppInstallations } from "./app_installations.js";
import dbActions from './db/mongo/actions.js';
import fulfillmentWebhookHandler from './helpers/fulfillment-webhook-handler.js';
// import {unless} from 'express-unless';
import { createSubscription, createDiscountSubscription, checkSub, cancelSubscription } from './GQL/mutations.js';
import returnTopLevelRedirection from './helpers/return-top-level-redirection.js';
import redirectToAuth from "./helpers/redirect-to-auth.js";
import discounts from './helpers/store-discounts.js';





const USE_ONLINE_TOKENS = false;
const TOP_LEVEL_OAUTH_COOKIE = "shopify_top_level_oauth";

const PORT = parseInt(process.env.BACKEND_PORT || process.env.PORT, 10);

// TODO: There should be provided by env vars
const DEV_INDEX_PATH = `${process.cwd()}/frontend/`;
const PROD_INDEX_PATH = `${process.cwd()}/frontend/dist/`;

const DB_PATH = `${process.cwd()}/database.sqlite`;

Shopify.Context.initialize({
  API_KEY: process.env.SHOPIFY_API_KEY,
  API_SECRET_KEY: process.env.SHOPIFY_API_SECRET,
  SCOPES: process.env.SCOPES.split(","),
  HOST_NAME: process.env.HOST.replace(/https?:\/\//, ""),
  HOST_SCHEME: process.env.HOST.split("://")[0],
  API_VERSION: LATEST_API_VERSION,
  IS_EMBEDDED_APP: true,
  // This should be replaced with your preferred storage strategy
  SESSION_STORAGE: new Shopify.Session.SQLiteSessionStorage(DB_PATH),
});
Shopify.Webhooks.Registry.addHandler("APP_UNINSTALLED", {
  path: "/api/webhooks",
  webhookHandler: async (_topic, shop, _body) => {
    await AppInstallations.delete(shop);
  },
});


// The transactions with Shopify will always be marked as test transactions, unless NODE_ENV is production.
// See the ensureBilling helper to learn more about billing in this template.
const BILLING_SETTINGS = {
  required: true,
  // This is an example configuration that would do a one-time charge for $5 (only USD is currently supported)
  chargeName: "Unlimited",
  amount: 3.99,
  currencyCode: "USD",
  interval: BillingInterval.Every30Days,
};

// This sets up the mandatory GDPR webhooks. You’ll need to fill in the endpoint
// in the “GDPR mandatory webhooks” section in the “App setup” tab, and customize
// the code when you store customer data.
//
// More details can be found on shopify.dev:
// https://shopify.dev/apps/webhooks/configuration/mandatory-webhooks
setupGDPRWebHooks("/api/webhooks");

// export for test use only
export async function createServer(
  root = process.cwd(),
  isProd = process.env.NODE_ENV === "production",
  billingSettings = BILLING_SETTINGS
) {
  const app = express();
  app.use(cors());
  app.set("top-level-oauth-cookie", TOP_LEVEL_OAUTH_COOKIE);
  app.set("use-online-tokens", USE_ONLINE_TOKENS);

  app.use(cookieParser(Shopify.Context.API_SECRET_KEY));

  applyAuthMiddleware(app, {
    billing: billingSettings,
  });

  // Do not call app.use(express.json()) before processing webhooks with
  // Shopify.Webhooks.Registry.process().
  // See https://github.com/Shopify/shopify-api-node/blob/main/docs/usage/webhooks.md#note-regarding-use-of-body-parsers
  // for more details.

  app.post("/api/webhooks", async (req, res) => {
    console.log('HIT WEBHOOK')
    try {
      await Shopify.Webhooks.Registry.process(req, res);
      console.log(`Webhook processed, returned status code 200`);
    } catch (e) {
      console.log(`Failed to process webhook: ${e.message}`);
      if (!res.headersSent) {
        res.status(500).send(e.message);
      }
    }
  });

  app.use(bodyParser.json());
  app.use(
    bodyParser.urlencoded({
      extended: true,
    })
  );


  app.get("/api/charge", async (req, res) => {
    const session = await Shopify.Utils.loadCurrentSession(
      req,
      res, 
      app.get("use-online-tokens")
    ); 

    if(!session) return res.status(401).send();

    const {plan} = req.query;

    const discount = await dbActions.get.discount(session.shop);

    const charge = !discount 
      ? await createSubscription({shop:session.shop,accessToken:session.accessToken,plan})
      : await createDiscountSubscription({shop:session.shop,accessToken:session.accessToken,plan})

    console.log("CHARGE:", charge);
    if(charge.appSubscription.lineItems[1]){
      dbActions.update.user({shop:session.shop, updates:{usage_sub_id:charge.appSubscription.lineItems[1].id}});
    }

    
    charge ? returnTopLevelRedirection(req,res,charge.confirmationUrl) : res.status(500).send();
  });

  app.delete("/api/charge", async (req, res) => {
    const session = await Shopify.Utils.loadCurrentSession(
      req,
      res, 
      app.get("use-online-tokens")
    ); 

    if(!session) return res.status(401).send();

    const canceledCharge = await cancelSubscription(session);

    console.log("canceledCharge:", canceledCharge);
    
    canceledCharge.userErrors.length<1 ? res.status(200).send() : res.status(500).send();
  });


  // All endpoints after this point will require an active session
  app.use(
    "/api/*",
    verifyRequest(app, {
      billing: billingSettings,
    }),
    async (req, res, next) => {

    const session = await Shopify.Utils.loadCurrentSession(
      req,
      res,
      app.get("use-online-tokens") 
    ); 

    next();
      
    }
  );


  app.get("/api/user", async (req, res,next) => {
    const session = await Shopify.Utils.loadCurrentSession(
      req,
      res,
      app.get("use-online-tokens") 
    ); 

    let user = await dbActions.get.user(session.shop);
    
    if(!user) user = await dbActions.create.user({shop: session.shop, accessToken: session.accessToken});

    user = user.toObject();

    res.status(200).send(user);
  });

  app.put("/api/memos/update", async (req, res) => {
    console.log('updating memos');
    const session = await Shopify.Utils.loadCurrentSession(
      req,
      res, 
      app.get("use-online-tokens")
    ); 

    const productChanges = req.body;

    console.log('productChanges:', productChanges);

    const updatesMemos = await dbActions.update.memo({memos:productChanges, shop:session.shop});

    updatesMemos ? res.status(200).send() : res.status(500).send();
  });

  
  app.use(express.json());
  

  if (isProd) {
    const compression = await import("compression").then(
      ({ default: fn }) => fn
    );
    const serveStatic = await import("serve-static").then(
      ({ default: fn }) => fn
    );
    app.use(compression());
    app.use(serveStatic(PROD_INDEX_PATH, { index: false }));
  }

  app.use("/*", async (req, res, next) => {

    // let domain = Buffer.from(req.query.host, 'base64').toString('ascii');
    const shop = Shopify.Utils.sanitizeShop(req.query.shop);
    // AppInstallations.delete(shop);

    if (!shop) {
      res.status(500);
      return res.send("No shop provided");
    }

    const appInstalled = await AppInstallations.includes(shop);

    if ((shop && !appInstalled) || (!req.query.host)) {
      res.redirect(`/api/auth?shop=${encodeURIComponent(shop)}&host=${req.query.host}`);
    } else {
      res.setHeader(
        "Content-Security-Policy",
        `frame-ancestors https://${encodeURIComponent(
          shop
        )} https://admin.shopify.com;`
      );
      console.log('app IS installed');
      const fs = await import("fs");
      const fallbackFile = join(
        isProd ? PROD_INDEX_PATH : DEV_INDEX_PATH,
        "index.html"
      );
      res
        .status(200)
        .set("Content-Type", "text/html")
        .send(fs.readFileSync(fallbackFile));
    }
  });

  return { app };
}

createServer().then(({ app }) => app.listen(PORT));
