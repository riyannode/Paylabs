import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { toHex } from "viem";

const pk = generatePrivateKey();
const account = privateKeyToAccount(pk);
const nonceBytes = new Uint8Array(32);
crypto.getRandomValues(nonceBytes);
const nonce = toHex(nonceBytes);
const now = Math.floor(Date.now() / 1000);

const payload = {
  x402Version: 2,
  resource: { url: "/api/paylabs/discovery", description: "PayLabs discovery fee", mimeType: "application/json" },
  accepted: {
    scheme: "exact", network: "eip155:5042002",
    asset: "0x3600000000000000000000000000000000000000",
    amount: "1000", payTo: "0xb5114ba71523b2f08a56924ded4133b3dd77a57b",
    maxTimeoutSeconds: 604900,
    extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" }
  },
  payload: {
    authorization: { from: account.address, to: "0xb5114ba71523b2f08a56924ded4133b3dd77a57b", value: "1000", validAfter: String(now - 600), validBefore: String(now + 604900), nonce },
    signature: await account.signTypedData({
      domain: { name: "GatewayWalletBatched", version: "1", chainId: 5042002, verifyingContract: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" },
      types: { TransferWithAuthorization: [{name:"from",type:"address"},{name:"to",type:"address"},{name:"value",type:"uint256"},{name:"validAfter",type:"uint256"},{name:"validBefore",type:"uint256"},{name:"nonce",type:"bytes32"}] },
      primaryType: "TransferWithAuthorization",
      message: { from: account.address, to: "0xb5114ba71523b2f08a56924ded4133b3dd77a57b", value: 1000n, validAfter: BigInt(now-600), validBefore: BigInt(now+604900), nonce }
    })
  }
};

const reqs = { scheme: "exact", network: "eip155:5042002", asset: "0x3600000000000000000000000000000000000000", amount: "1000", payTo: "0xb5114ba71523b2f08a56924ded4133b3dd77a57b", maxTimeoutSeconds: 604900, extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" } };

console.log("Sending to Gateway /v1/x402/settle...");
const res = await fetch("https://gateway-api-testnet.circle.com/v1/x402/settle", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ paymentPayload: payload, paymentRequirements: reqs })
});
console.log("Status:", res.status);
const text = await res.text();
console.log("Response:", text);
