import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const authorityImage =
  "node:24-bookworm-slim@sha256:51b1100cc2a83d370c6a60952e3f2989c8a43159d0e38586e090f3b3326efefd";
export const issuer = "https://proof-issuer:8443";
export const authorizedParty = "https://synthetic.damadama.invalid";

export async function syntheticAuthority(directory, execute) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const kid = randomUUID();
  const jwk = {
    ...publicKey.export({ format: "jwk" }),
    use: "sig",
    alg: "RS256",
    kid,
  };
  const ca = resolve(directory, "ca.pem");
  const key = resolve(directory, "tls.key");
  execute("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-days",
    "1",
    "-subj",
    "/CN=Recovery synthetic issuer",
    "-addext",
    "subjectAltName=DNS:proof-issuer",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-keyout",
    key,
    "-out",
    ca,
  ]);
  await writeFile(
    resolve(directory, "issuer.mjs"),
    `import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
const issuer = ${JSON.stringify(issuer)};
const jwks = ${JSON.stringify({ keys: [jwk] })};
createServer({ key: readFileSync('/authority/tls.key'), cert: readFileSync('/authority/ca.pem') }, (request, response) => {
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/.well-known/openid-configuration') response.end(JSON.stringify({ issuer, jwks_uri: issuer + '/jwks', response_types_supported: ['id_token'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'] }));
  else if (request.url === '/jwks') response.end(JSON.stringify(jwks));
  else { response.statusCode = 404; response.end('{}'); }
}).listen(8443, '0.0.0.0');
`,
  );
  const token = (claims = {}, key = privateKey) => {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", typ: "JWT", kid }),
    ).toString("base64url");
    const body = Buffer.from(
      JSON.stringify({
        iss: issuer,
        sub: "recovery-api-owner",
        azp: authorizedParty,
        iat: now,
        nbf: now - 10,
        exp: now + 1800,
        ...claims,
      }),
    ).toString("base64url");
    const payload = `${header}.${body}`;
    return `${payload}.${sign("RSA-SHA256", Buffer.from(payload), key).toString("base64url")}`;
  };
  const otherKey = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  }).privateKey;
  return {
    ca,
    token,
    refused: {
      invalidSignature: token({}, otherKey),
      wrongIssuer: token({ iss: "https://wrong.invalid" }),
      expired: token({ nbf: 1, exp: 2 }),
      missingSubject: token({ sub: undefined }),
      wrongAuthorizedParty: token({ azp: "https://wrong.invalid" }),
      pendingSession: token({ sts: "pending" }),
    },
  };
}
