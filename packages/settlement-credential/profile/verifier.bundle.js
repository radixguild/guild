(() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  function __accessProp(key) {
    return this[key];
  }
  var __toCommonJS = (from) => {
    var entry = (__moduleCache ??= new WeakMap).get(from), desc;
    if (entry)
      return entry;
    entry = __defProp({}, "__esModule", { value: true });
    if (from && typeof from === "object" || typeof from === "function") {
      for (var key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(entry, key))
          __defProp(entry, key, {
            get: __accessProp.bind(from, key),
            enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
          });
    }
    __moduleCache.set(from, entry);
    return entry;
  };
  var __moduleCache;

  // src/browser-verifier.ts
  var exports_browser_verifier = {};

  // src/jcs.ts
  function canonicalize(value) {
    return canon(value);
  }
  function canon(value) {
    if (value === null || value === undefined)
      return "null";
    if (typeof value === "boolean")
      return value ? "true" : "false";
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new Error(`JCS: cannot canonicalize non-finite number (${value})`);
      }
      return String(value);
    }
    if (typeof value === "string")
      return JSON.stringify(value);
    if (Array.isArray(value)) {
      return "[" + value.map((v) => canon(v)).join(",") + "]";
    }
    if (typeof value === "object") {
      const obj = value;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
      return "{" + keys.map((k) => `${JSON.stringify(k)}:${canon(obj[k])}`).join(",") + "}";
    }
    throw new Error(`JCS: cannot canonicalize value of type ${typeof value}`);
  }
  function canonicalizeToBytes(value) {
    return new TextEncoder().encode(canonicalize(value));
  }

  // src/bytes.ts
  function isHex(value, byteLength) {
    if (!/^[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0)
      return false;
    return byteLength === undefined ? value.length > 0 : value.length === byteLength * 2;
  }
  function hexToBytes(hex) {
    if (!isHex(hex))
      throw new Error("Invalid hex string");
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0;i < out.length; i++) {
      out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  // src/base58.ts
  var ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  var ALPHABET_MAP = new Map([...ALPHABET].map((c, i) => [c, i]));
  function base58btcDecode(input) {
    if (input.length === 0)
      return new Uint8Array(0);
    let value = 0n;
    for (const ch of input) {
      const digit = ALPHABET_MAP.get(ch);
      if (digit === undefined) {
        throw new Error(`invalid base58btc character: ${JSON.stringify(ch)}`);
      }
      value = value * 58n + BigInt(digit);
    }
    const bytes = [];
    while (value > 0n) {
      bytes.unshift(Number(value & 0xffn));
      value >>= 8n;
    }
    let leadingOnes = 0;
    for (const ch of input) {
      if (ch !== "1")
        break;
      leadingOnes++;
    }
    return new Uint8Array([...new Array(leadingOnes).fill(0), ...bytes]);
  }

  // src/did-key.ts
  var MULTICODEC_ED25519_PUB = new Uint8Array([237, 1]);
  var ED25519_PUBLIC_KEY_BYTES = 32;
  function didKeyToPublicKeyBytes(did) {
    const match = /^did:key:z([1-9A-HJ-NP-Za-km-z]+)$/.exec(did);
    if (!match) {
      throw new Error(`not a base58btc did:key: ${JSON.stringify(did)}`);
    }
    const decoded = base58btcDecode(match[1]);
    if (decoded.length !== MULTICODEC_ED25519_PUB.length + ED25519_PUBLIC_KEY_BYTES) {
      throw new Error(`did:key decodes to the wrong length (${decoded.length} bytes)`);
    }
    if (decoded[0] !== MULTICODEC_ED25519_PUB[0] || decoded[1] !== MULTICODEC_ED25519_PUB[1]) {
      throw new Error("did:key is not an Ed25519 key (multicodec 0xed01)");
    }
    return decoded.slice(MULTICODEC_ED25519_PUB.length);
  }
  function didFromVerificationMethod(verificationMethodId) {
    const hashIndex = verificationMethodId.indexOf("#");
    return hashIndex === -1 ? verificationMethodId : verificationMethodId.slice(0, hashIndex);
  }

  // src/schema.ts
  var PROOF_TYPE = "Ed25519Signature2020Jcs";

  // src/sign.ts
  function signableBytes(credential) {
    const { proofs: _proofs, ...unsigned } = credential;
    return canonicalizeToBytes(unsigned);
  }

  // src/verify.ts
  async function verifyOneProof(message, proof) {
    const base = {
      role: proof.role,
      verificationMethod: proof.verificationMethod
    };
    try {
      if (proof.type !== PROOF_TYPE) {
        return { ...base, valid: false, error: `unsupported proof type: ${proof.type}` };
      }
      const did = didFromVerificationMethod(proof.verificationMethod);
      const publicKeyRaw = didKeyToPublicKeyBytes(did);
      const publicKey = await crypto.subtle.importKey("raw", Uint8Array.from(publicKeyRaw), "Ed25519", false, ["verify"]);
      const signature = hexToBytes(proof.signature);
      const ok = await crypto.subtle.verify("Ed25519", publicKey, Uint8Array.from(signature), Uint8Array.from(message));
      return { ...base, valid: ok, error: ok ? undefined : "signature does not match" };
    } catch (err) {
      return { ...base, valid: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  async function verifyCredential(credential, options = {}) {
    const requireWitness = options.requireWitness ?? true;
    const message = signableBytes(credential);
    const perProof = await Promise.all(credential.proofs.map((p) => verifyOneProof(message, p)));
    const errors = [];
    if (perProof.length === 0)
      errors.push("unsigned: this credential carries no proofs");
    const badProofs = perProof.filter((p) => !p.valid);
    for (const p of badProofs) {
      errors.push(`proof from ${p.verificationMethod} (${p.role}) failed: ${p.error ?? "invalid signature"}`);
    }
    const hasWitness = perProof.some((p) => p.role === "witness");
    if (requireWitness && perProof.length > 0 && !hasWitness) {
      errors.push("missing witness proof");
    }
    const valid = perProof.length > 0 && badProofs.length === 0 && (!requireWitness || hasWitness);
    return { valid, proofCount: perProof.length, hasWitness, perProof, errors };
  }

  // src/browser-verifier.ts
  globalThis.SettlementCredential = { canonicalize, verifyCredential };
})();
