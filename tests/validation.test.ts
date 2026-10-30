/**
 * @file tests/validation.test.ts
 * Unit tests for validation-example.ts
 */

import { CreateInquirySchema, InquiryQuerySchema } from '../recommendations/validation-example';

describe('CreateInquirySchema', () => {
  const validBase = {
    fullName: 'Aarav Sharma',
    email: '  Aarav@Example.COM  ',
    company: 'Cynbit Technologies',
    industry: 'AI_AUTOMATION',
    message: 'We need AI automation help for our business.',
  };

  test('accepts a valid payload and normalises email', async () => {
    const result = await CreateInquirySchema.safeParseAsync(validBase);
    expect(result.success).toBe(true);
    if (result.success) {
      // Email must be trimmed and lowercased
      expect(result.data.email).toBe('aarav@example.com');
      // Name must be trimmed
      expect(result.data.fullName).toBe('Aarav Sharma');
    }
  });

  test('accepts international Unicode names', async () => {
    const names = ['Müller', 'García', 'O\'Brien', 'Nguyen-Thi', 'Иванов'];
    for (const name of names) {
      const result = await CreateInquirySchema.safeParseAsync({ ...validBase, fullName: name });
      expect(result.success).toBe(true);
    }
  });

  test('rejects names with numbers or special symbols', async () => {
    const result = await CreateInquirySchema.safeParseAsync({ ...validBase, fullName: 'John123' });
    expect(result.success).toBe(false);
  });

  test('rejects name shorter than 2 characters', async () => {
    const result = await CreateInquirySchema.safeParseAsync({ ...validBase, fullName: 'A' });
    expect(result.success).toBe(false);
  });

  test('rejects invalid email', async () => {
    const result = await CreateInquirySchema.safeParseAsync({ ...validBase, email: 'not-an-email' });
    expect(result.success).toBe(false);
  });

  test('rejects message shorter than 10 characters', async () => {
    const result = await CreateInquirySchema.safeParseAsync({ ...validBase, message: 'Short' });
    expect(result.success).toBe(false);
  });

  test('rejects message longer than 3000 characters', async () => {
    const result = await CreateInquirySchema.safeParseAsync({ ...validBase, message: 'A'.repeat(3001) });
    expect(result.success).toBe(false);
  });

  test('rejects non-empty honeypot (bot detection)', async () => {
    const result = await CreateInquirySchema.safeParseAsync({ ...validBase, website_trap: 'I am a bot' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors[0].message).toMatch(/Automated submission detected/);
    }
  });

  test('accepts empty honeypot', async () => {
    const result = await CreateInquirySchema.safeParseAsync({ ...validBase, website_trap: '' });
    expect(result.success).toBe(true);
  });

  test('defaults industry to OTHER when omitted', async () => {
    const { industry: _, ...withoutIndustry } = validBase;
    const result = await CreateInquirySchema.safeParseAsync(withoutIndustry);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.industry).toBe('OTHER');
    }
  });
});

describe('InquiryQuerySchema — pagination', () => {
  test('accepts valid numeric page and limit', async () => {
    const result = await InquiryQuerySchema.safeParseAsync({ page: '2', limit: '25' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(2);
      expect(result.data.limit).toBe(25);
    }
  });

  test('rejects non-integer page (e.g. "3.5")', async () => {
    const result = await InquiryQuerySchema.safeParseAsync({ page: '3.5' });
    expect(result.success).toBe(false);
  });

  test('rejects alphanumeric page (e.g. "2abc")', async () => {
    const result = await InquiryQuerySchema.safeParseAsync({ page: '2abc' });
    expect(result.success).toBe(false);
  });

  test('rejects limit above 100', async () => {
    const result = await InquiryQuerySchema.safeParseAsync({ limit: '200' });
    expect(result.success).toBe(false);
  });

  test('defaults page to 1 and limit to 20 when omitted', async () => {
    const result = await InquiryQuerySchema.safeParseAsync({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.limit).toBe(20);
    }
  });
});
