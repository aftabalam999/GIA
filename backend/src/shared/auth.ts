import crypto from 'crypto';
import { promisify } from 'util';

const scrypt = promisify(crypto.scrypt);

/**
 * Hashes a plain-text password using scrypt with a unique salt.
 * Returns the hash in the format: salt$hash
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}$${derivedKey.toString('hex')}`;
}

/**
 * Verifies a plain-text password against a stored scrypt hash using timing-safe comparison.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    const parts = hash.split('$');
    if (parts.length !== 2) return false;
    
    const [salt, key] = parts;
    const derivedKey = (await scrypt(password, salt, 64)) as Buffer;
    const hashBuffer = Buffer.from(key, 'hex');
    
    if (derivedKey.length !== hashBuffer.length) return false;
    return crypto.timingSafeEqual(derivedKey, hashBuffer);
  } catch {
    return false;
  }
}
