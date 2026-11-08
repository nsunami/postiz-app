import { sign, verify } from 'jsonwebtoken';
import { hashSync, compareSync } from 'bcrypt';
import crypto from 'crypto';
// @ts-ignore
import EVP_BytesToKey from 'evp_bytestokey';
const algorithm = 'aes-256-cbc';
const { keyLength, ivLength } = crypto.getCipherInfo(algorithm);

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_DIGITS = 6;
const TOTP_PERIOD_SECONDS = 30;

function base32Encode(buffer: Buffer) {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

function base32Decode(input: string) {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      continue;
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

function deriveLegacyKeyIv(secret: string) {
  const { keyLength, ivLength } = crypto.getCipherInfo(algorithm); // 32, 16
  const pass = Buffer.isBuffer(secret) ? secret : Buffer.from(secret ?? '', 'utf8');

  // evp_bytestokey: key length in **bits**, IV length in **bytes**
  const { key, iv } = EVP_BytesToKey(pass, null, keyLength * 8, ivLength, 'md5');

  if (key.length !== keyLength || iv.length !== ivLength) {
    throw new Error(`Derived wrong sizes (key=${key.length}, iv=${iv.length})`);
  }
  return { key, iv };
}

export function decrypt_legacy_using_IV(hexCiphertext: string) {
  const { key, iv } = deriveLegacyKeyIv(process.env.JWT_SECRET);
  const decipher = crypto.createDecipheriv(algorithm, key, iv);
  const out = Buffer.concat([decipher.update(hexCiphertext, 'hex'), decipher.final()]);
  return out.toString('utf8');
}

export function encrypt_legacy_using_IV(utf8Plaintext: string) {
  const { key, iv } = deriveLegacyKeyIv(process.env.JWT_SECRET);
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  const out = Buffer.concat([cipher.update(utf8Plaintext, 'utf8'), cipher.final()]);
  return out.toString('hex');
}
export class AuthService {
  static hashPassword(password: string) {
    return hashSync(password, 10);
  }
  static comparePassword(password: string, hash: string) {
    return compareSync(password, hash);
  }
  static signJWT(value: object) {
    return sign(value, process.env.JWT_SECRET!);
  }
  static verifyJWT(token: string) {
    return verify(token, process.env.JWT_SECRET!);
  }

  static generateTotpSecret() {
    return base32Encode(crypto.randomBytes(20));
  }

  static totpCode(secret: string, step: number) {
    const counter = Buffer.alloc(8);
    counter.writeUInt32BE(Math.floor(step / 0x100000000), 0);
    counter.writeUInt32BE(step % 0x100000000, 4);

    const digest = crypto
      .createHmac('sha1', base32Decode(secret))
      .update(counter)
      .digest();
    const offset = digest[digest.length - 1] & 0xf;
    const value =
      ((digest[offset] & 0x7f) << 24) |
      ((digest[offset + 1] & 0xff) << 16) |
      ((digest[offset + 2] & 0xff) << 8) |
      (digest[offset + 3] & 0xff);

    return String(value % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
  }

  /**
   * Returns the TOTP step the code matched, or null when it doesn't match.
   * A window of 1 accepts the previous and next step to tolerate clock drift.
   */
  static verifyTotp(secret: string, code: string, window = 1) {
    if (!/^\d{6}$/.test(code)) {
      return null;
    }

    const currentStep = Math.floor(Date.now() / (TOTP_PERIOD_SECONDS * 1000));

    for (let offset = -window; offset <= window; offset++) {
      const step = currentStep + offset;
      const expected = AuthService.totpCode(secret, step);
      if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code))) {
        return step;
      }
    }

    return null;
  }

  static totpUri(secret: string, account: string, issuer = 'Postiz') {
    const label = encodeURIComponent(`${issuer}:${account}`);
    return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(
      issuer
    )}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
  }

  static encryptSecret(value: string) {
    const key = crypto
      .createHash('sha256')
      .update(process.env.TWO_FACTOR_SECRET || process.env.JWT_SECRET || '')
      .digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ]);

    return `v1:${iv.toString('hex')}:${cipher
      .getAuthTag()
      .toString('hex')}:${encrypted.toString('hex')}`;
  }

  static decryptSecret(payload: string) {
    const [version, iv, authTag, encrypted] = payload.split(':');
    if (version !== 'v1' || !iv || !authTag || !encrypted) {
      throw new Error('Unsupported two-factor secret format');
    }

    const key = crypto
      .createHash('sha256')
      .update(process.env.TWO_FACTOR_SECRET || process.env.JWT_SECRET || '')
      .digest();
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(iv, 'hex')
    );
    decipher.setAuthTag(Buffer.from(authTag, 'hex'));

    return Buffer.concat([
      decipher.update(Buffer.from(encrypted, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  }

  static fixedEncryption(value: string) {
    return encrypt_legacy_using_IV(value);
  }

  static fixedDecryption(hash: string) {
    return decrypt_legacy_using_IV(hash);
  }
}
