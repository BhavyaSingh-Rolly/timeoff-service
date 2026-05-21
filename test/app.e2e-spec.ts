import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';

describe('TimeOff E2E Suite', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );

    prisma = app.get(PrismaService);
    await app.init();
  });

  beforeEach(async () => {
    // Clear dependent tables first to respect database foreign-key constraints
    await prisma.balanceLedger.deleteMany();
    await prisma.timeOffRequest.deleteMany();
    await prisma.balance.deleteMany();
  });

  afterAll(async () => {
    await app.close();
  });

  it('happy path: request time off successfully', async () => {
    await request(app.getHttpServer())
      .post('/webhooks/hcm/balance-update')
      .send({
        employeeId: 'emp-happy',
        locationId: 'SF',
        balance: 10,
      });

    const createRes = await request(app.getHttpServer())
      .post('/timeoff/request')
      .send({
        employeeId: 'emp-happy',
        locationId: 'SF',
        daysRequested: 2,
        idempotencyKey: 'happy-1',
      })
      .expect(201);

    // Assert your service's immediate approval response
    expect(createRes.body.status).toBe('APPROVED');

    // Verify local balances reflect the deduction accurately
    const res = await request(app.getHttpServer())
      .get('/balances/emp-happy/SF')
      .expect(200);

    expect(res.body.balance).toBe(8);

    // Assert audit ledger logs match exactly (Reconciliation + Deduct)
    const ledgers = await prisma.balanceLedger.findMany({
      where: { employeeId: 'emp-happy' },
      orderBy: { createdAt: 'asc' }
    });
    expect(ledgers.length).toBe(2);
    expect(ledgers[0].eventType).toBe('HCM_RECONCILIATION');
    expect(ledgers[1].eventType).toBe('TIME_OFF_REQUEST');
    expect(ledgers[1].delta).toBe(-2);
  });

  it('rejects insufficient balance early', async () => {
    await request(app.getHttpServer())
      .post('/webhooks/hcm/balance-update')
      .send({
        employeeId: 'emp-low',
        locationId: 'SF',
        balance: 1,
      });

    await request(app.getHttpServer())
      .post('/timeoff/request')
      .send({
        employeeId: 'emp-low',
        locationId: 'SF',
        daysRequested: 5,
      })
      .expect(422);

    // Ensure no broken request items were left behind
    const requestCount = await prisma.timeOffRequest.count();
    expect(requestCount).toBe(0);
  });

  it('updates balance via HCM webhook sync', async () => {
    await request(app.getHttpServer())
      .post('/webhooks/hcm/balance-update')
      .send({
        employeeId: 'emp-sync',
        locationId: 'SF',
        balance: 15,
      });

    const res = await request(app.getHttpServer())
      .get('/balances/emp-sync/SF')
      .expect(200);

    expect(res.body.balance).toBe(15);
  });

  it('prevents concurrent overspending on parallel clicks', async () => {
    await request(app.getHttpServer())
      .post('/webhooks/hcm/balance-update')
      .send({
        employeeId: 'emp-race',
        locationId: 'SF',
        balance: 7,
      });

    const requests = Array.from({ length: 3 }).map((_, i) =>
      request(app.getHttpServer())
        .post('/timeoff/request')
        .send({
          employeeId: 'emp-race',
          locationId: 'SF',
          daysRequested: 5,
          idempotencyKey: `race-${i}`,
        }),
    );

    const responses = await Promise.all(requests);
    const successCount = responses.filter((r) => r.status === 201).length;

    expect(successCount).toBe(1);
  });

  it('does not double deduct on duplicate idempotency key retries', async () => {
    await request(app.getHttpServer())
      .post('/webhooks/hcm/balance-update')
      .send({
        employeeId: 'emp-idempotent',
        locationId: 'SF',
        balance: 10,
      });

    await request(app.getHttpServer())
      .post('/timeoff/request')
      .send({
        employeeId: 'emp-idempotent',
        locationId: 'SF',
        daysRequested: 2,
        idempotencyKey: 'same-key-1',
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/timeoff/request')
      .send({
        employeeId: 'emp-idempotent',
        locationId: 'SF',
        daysRequested: 2,
        idempotencyKey: 'same-key-1',
      })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/balances/emp-idempotent/SF')
      .expect(200);

    expect(res.body.balance).toBe(8);
  });

  it('processes HCM batch sync for multiple balances', async () => {
    await request(app.getHttpServer())
      .post('/webhooks/hcm/batch-sync')
      .send({
        balances: [
          { employeeId: 'emp-batch-1', locationId: 'SF', balance: 12 },
          { employeeId: 'emp-batch-2', locationId: 'NY', balance: 20 },
        ],
      })
      .expect(201);

    const sf = await request(app.getHttpServer())
      .get('/balances/emp-batch-1/SF')
      .expect(200);

    const ny = await request(app.getHttpServer())
      .get('/balances/emp-batch-2/NY')
      .expect(200);

    expect(sf.body.balance).toBe(12);
    expect(ny.body.balance).toBe(20);
  });

  it('rejects request for unknown employee/location balance configurations', async () => {
    await request(app.getHttpServer())
      .post('/timeoff/request')
      .send({
        employeeId: 'unknown-employee',
        locationId: 'SF',
        daysRequested: 1,
      })
      .expect(422);
  });

  it('rejects invalid inputs using Global ValidationPipes', async () => {
    await request(app.getHttpServer())
      .post('/timeoff/request')
      .send({
        employeeId: 'emp-invalid',
        locationId: 'SF',
        daysRequested: -5,
      })
      .expect(400);
  });

  it('rolls back local balance and writes a compensating ledger when HCM rejects request', async () => {
    await request(app.getHttpServer())
      .post('/webhooks/hcm/balance-update')
      .send({
        employeeId: 'hcm-fail',
        locationId: 'SF',
        balance: 10,
      });

    const requestRes = await request(app.getHttpServer())
      .post('/timeoff/request')
      .send({
        employeeId: 'hcm-fail',
        locationId: 'SF',
        daysRequested: 2,
        idempotencyKey: 'hcm-fail-1',
      })
      .expect(201);

    // Because your code runs synchronously, it returns FAILED_SYNC right here.
    expect(requestRes.body.status).toBe('FAILED_SYNC');

    // Verify balance was successfully refunded back to 10
    const res = await request(app.getHttpServer())
      .get('/balances/hcm-fail/SF')
      .expect(200);

    expect(res.body.balance).toBe(10);

    // Verify all 3 stages of ledger rows exist sequentially
    const ledgers = await prisma.balanceLedger.findMany({
      where: { employeeId: 'hcm-fail' },
      orderBy: { createdAt: 'asc' }
    });

    expect(ledgers.length).toBe(3);
    expect(ledgers[0].eventType).toBe('HCM_RECONCILIATION');
    expect(ledgers[1].eventType).toBe('TIME_OFF_REQUEST');
    expect(ledgers[1].delta).toBe(-2);
    expect(ledgers[2].eventType).toBe('HCM_REJECTION_ROLLBACK');
    expect(ledgers[2].delta).toBe(2);
  });
});