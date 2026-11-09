import { OAuth2Client } from "google-auth-library";

export function createGoogleProvider({clientId, clientSecret, redirectUri}, clientFactory = options => new OAuth2Client(options)) {
  if (typeof clientId !== "string" || !clientId.endsWith(".apps.googleusercontent.com") || !clientSecret)
    throw Error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from a Google Web application OAuth client.");
  const client = clientFactory({clientId, clientSecret, redirectUri, transporterOptions:{timeout:10000, retry:false}});
  return {
    authorizationUrl({state, nonce, codeChallenge, hostedDomain}) {
      return client.generateAuthUrl({
        scope:["openid", "email", "profile"], response_type:"code", access_type:"online",
        prompt:"select_account", state, nonce,
        code_challenge:codeChallenge, code_challenge_method:"S256",
        ...(hostedDomain ? {hd:hostedDomain} : {}),
      });
    },
    async verifyCode(code, verifier) {
      const {tokens} = await client.getToken({code, codeVerifier:verifier, redirect_uri:redirectUri});
      if (!tokens.id_token) throw Error("Google did not return an identity token.");
      const ticket = await client.verifyIdToken({idToken:tokens.id_token, audience:clientId});
      return ticket.getPayload();
    },
  };
}
