import { describe, expect, it } from 'vitest';
import { duplicateKeyField, duplicateKeyMessage, duplicateKeyResponse } from '../../utils/mongoErrors';

describe('mongoErrors', () => {
  it('detects duplicate phone errors', () => {
    const error = { code: 11000, keyPattern: { phone: 1 } };
    expect(duplicateKeyField(error)).toBe('phone');
    expect(duplicateKeyMessage(error)).toBe('A user with this phone number already exists');
    expect(duplicateKeyResponse(error)).toEqual({
      status: 409,
      msg: 'A user with this phone number already exists',
      field: 'phone',
    });
  });

  it('parses duplicate fields from mongo error messages', () => {
    const error = {
      code: 11000,
      message:
        'E11000 duplicate key error collection: fixera.users index: phone_1 dup key: { phone: "+918128463740" }',
    };
    expect(duplicateKeyField(error)).toBe('phone');
    expect(duplicateKeyMessage(error)).toBe('A user with this phone number already exists');
  });

  it('returns null for non-duplicate errors', () => {
    expect(duplicateKeyMessage(new Error('boom'))).toBeNull();
    expect(duplicateKeyMessage({ code: 11000 })).toBeNull();
  });
});
