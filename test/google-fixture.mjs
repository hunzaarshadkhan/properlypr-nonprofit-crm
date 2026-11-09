// Local-only signed Google OAuth fixture. Never used by the production provider.
import http from "node:http";
import { randomBytes, generateKeyPairSync, createSign, createHash } from "node:crypto";
import { once } from "node:events";
import { OAuth2Client } from "google-auth-library";
import { createGoogleProvider } from "../server/google.mjs";

export async function googleFixture() {
  const {privateKey,publicKey} = generateKeyPairSync("rsa", {modulusLength:2048});
  const codes = new Map();
  const clientId = "fixture.apps.googleusercontent.com", clientSecret = "fixture-only-secret";
  const server = http.createServer(async (req,res) => {
    const path = new URL(req.url,"http://fixture").pathname;
    if (path === "/certs") {
      res.writeHead(200,{"Content-Type":"application/json","Cache-Control":"public, max-age=3600"});
      res.end(JSON.stringify({fixture:publicKey.export({type:"spki",format:"pem"})})); return;
    }
    if (path === "/token" && req.method === "POST") {
      let body="";for await(const chunk of req) body += chunk;
      const params = new URLSearchParams(body), item=codes.get(params.get("code"));
      codes.delete(params.get("code"));
      const actual = createHash("sha256").update(params.get("code_verifier") || "").digest("base64url");
      if (!item || actual !== item.challenge || params.get("client_id") !== clientId || params.get("client_secret") !== clientSecret) {
        res.writeHead(400,{"Content-Type":"application/json"});res.end('{"error":"invalid_grant"}'); return;
      }
      const now=Math.floor(Date.now()/1000);
      const claims = {iss:"https://accounts.google.com",aud:clientId,iat:now,exp:now+3600,sub:"google-fixture-user",email:"rep@gmail.com",email_verified:true,name:"QA Rep",nonce:item.nonce,...item.claims};
      const encode=o=>Buffer.from(JSON.stringify(o)).toString("base64url");
      const data=encode({alg:"RS256",kid:"fixture",typ:"JWT"})+"."+encode(claims);
      const signer=createSign("RSA-SHA256");signer.update(data);signer.end();
      let signature=signer.sign(privateKey).toString("base64url");
      if(item.badSignature) signature=(signature.startsWith("A")?"B":"A")+signature.slice(1);
      res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({id_token:data+"."+signature,access_token:"fixture-only",token_type:"Bearer",expires_in:3600}));return;
    }
    res.writeHead(404).end();
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const origin="http://127.0.0.1:"+server.address().port;
  return {
    provider(redirectUri) {
      return createGoogleProvider({clientId,clientSecret,redirectUri},options=>new OAuth2Client({...options,endpoints:{oauth2TokenUrl:origin+"/token",oauth2FederatedSignonPemCertsUrl:origin+"/certs"}}));
    },
    code(authUrl,claims={},badSignature=false) {
      const url=new URL(authUrl), code=randomBytes(32).toString("hex");
      codes.set(code,{challenge:url.searchParams.get("code_challenge"),nonce:url.searchParams.get("nonce"),claims,badSignature});
      return code;
    },
    close:()=>new Promise(r=>server.close(r)),
  };
}
