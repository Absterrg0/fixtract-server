import { describe, expect, it } from 'vitest';
import { toHandlerError } from '../../utils/handlerErrors';

describe('handlerErrors', () => {
  it('maps duplicate key errors to field-specific responses', () => {
    const result = toHandlerError(
      {
        code: 11000,
        message:
          'E11000 duplicate key error collection: fixera.users index: phone_1 dup key: { phone: "+918128463740" }',
      },
      'Failed to invite staff'
    );

    expect(result).toEqual({
      status: 409,
      body: {
        success: false,
        msg: 'A user with this phone number already exists',
        field: 'phone',
      },
    });
  });
});
