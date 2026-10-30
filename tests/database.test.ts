/**
 * @file tests/database.test.ts
 * Unit tests for InquiryRepository (cache invalidation, typed operations).
 * Database and Redis are mocked — no live connections are required.
 */

import { InquiryRepository, InquiryRecord, PrismaInquiryClient } from '../recommendations/database-example';
import type { CreateInquiryDTO } from '../recommendations/validation-example';

// ── Fixtures ──────────────────────────────────────────────────────────────────
const makeRecord = (overrides: Partial<InquiryRecord> = {}): InquiryRecord => ({
  id: 'uuid-1',
  fullName: 'Aarav Sharma',
  email: 'aarav@example.com',
  company: 'Cynbit',
  industry: 'AI_AUTOMATION',
  message: 'Looking for AI automation help.',
  status: 'PENDING',
  clientIp: '192.168.0.1',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

const makeDto = (): CreateInquiryDTO => ({
  fullName: 'Aarav Sharma',
  email: 'aarav@example.com',
  company: 'Cynbit',
  industry: 'AI_AUTOMATION',
  message: 'Looking for AI automation help.',
  website_trap: '',
});

// ── Mock Prisma ───────────────────────────────────────────────────────────────
function makePrisma(record: InquiryRecord = makeRecord()): PrismaInquiryClient {
  return {
    inquiry: {
      create: jest.fn().mockResolvedValue(record),
      findUnique: jest.fn().mockResolvedValue(record),
      findMany: jest.fn().mockResolvedValue([record]),
      count: jest.fn().mockResolvedValue(1),
      update: jest.fn().mockResolvedValue({ ...record, status: 'REVIEWED' }),
    },
    $transaction: jest.fn().mockImplementation(async (fn) => fn({ inquiry: {
      findMany: jest.fn().mockResolvedValue([record]),
      count: jest.fn().mockResolvedValue(1),
    }})),
  };
}

// ── Mock Redis ────────────────────────────────────────────────────────────────
function makeRedis(cachedValue: string | null = null) {
  return {
    get: jest.fn().mockResolvedValue(cachedValue),
    setEx: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
describe('InquiryRepository.create', () => {
  test('calls prisma.inquiry.create with correct data', async () => {
    const prisma = makePrisma();
    const repo = new InquiryRepository(prisma);
    const result = await repo.create(makeDto(), '1.2.3.4');

    expect(prisma.inquiry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'aarav@example.com',
          status: 'PENDING',
          clientIp: '1.2.3.4',
        }),
      })
    );
    expect(result.id).toBe('uuid-1');
  });
});

describe('InquiryRepository.findById — caching', () => {
  test('returns cached value without hitting DB when cache hit', async () => {
    const record = makeRecord();
    const prisma = makePrisma(record);
    const redis = makeRedis(JSON.stringify(record)); // cache hit
    const repo = new InquiryRepository(prisma, redis);

    const result = await repo.findById('uuid-1');

    expect(result).not.toBeNull();
    expect(prisma.inquiry.findUnique).not.toHaveBeenCalled();
    expect(redis.get).toHaveBeenCalledWith('cynbit:inquiry:uuid-1');
  });

  test('reads from DB and populates cache on cache miss', async () => {
    const record = makeRecord();
    const prisma = makePrisma(record);
    const redis = makeRedis(null); // cache miss
    const repo = new InquiryRepository(prisma, redis);

    await repo.findById('uuid-1');

    expect(prisma.inquiry.findUnique).toHaveBeenCalled();
    expect(redis.setEx).toHaveBeenCalledWith('cynbit:inquiry:uuid-1', 600, expect.any(String));
  });

  test('falls back to DB gracefully when Redis throws', async () => {
    const record = makeRecord();
    const prisma = makePrisma(record);
    const redis = {
      get: jest.fn().mockRejectedValue(new Error('Redis connection refused')),
      setEx: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };
    const repo = new InquiryRepository(prisma, redis);

    const result = await repo.findById('uuid-1');

    // Should not throw; DB is the fallback
    expect(result).not.toBeNull();
    expect(prisma.inquiry.findUnique).toHaveBeenCalled();
  });
});

describe('InquiryRepository.updateStatus — cache invalidation', () => {
  test('deletes cache entry after successful update', async () => {
    const prisma = makePrisma();
    const redis = makeRedis();
    const repo = new InquiryRepository(prisma, redis);

    await repo.updateStatus('uuid-1', 'REVIEWED');

    expect(prisma.inquiry.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'uuid-1' }, data: { status: 'REVIEWED' } })
    );
    expect(redis.del).toHaveBeenCalledWith('cynbit:inquiry:uuid-1');
  });

  test('does not throw if cache delete fails', async () => {
    const prisma = makePrisma();
    const redis = {
      ...makeRedis(),
      del: jest.fn().mockRejectedValue(new Error('Redis timeout')),
    };
    const repo = new InquiryRepository(prisma, redis);

    // Should not throw even if del fails
    await expect(repo.updateStatus('uuid-1', 'ARCHIVED')).resolves.toBeDefined();
  });
});
