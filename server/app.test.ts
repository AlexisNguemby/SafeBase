import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// Les mocks remplacent la base de données (Prisma) et le worker Go (axios).
// On teste ainsi la logique du serveur seule, sans Docker.
// vi.hoisted s'exécute avant les imports : les variables d'environnement sont
// donc définies avant que app.ts ne construise TARGET_DATABASES.
const { prismaMock, axiosMock } = vi.hoisted(() => {
  process.env.POSTGRES_DB = 'safebase_db';
  process.env.POSTGRES_USER = 'safebase_user';
  process.env.POSTGRES_PASSWORD = 'prod-secret-password';
  process.env.CLIENT_DB_NAME = 'client_db';
  process.env.CLIENT_DB_USER = 'client_user';
  process.env.CLIENT_DB_PASSWORD = 'client-secret-password';

  return {
    prismaMock: {
      user: { findUnique: vi.fn() },
      backupHistory: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    },
    axiosMock: { post: vi.fn() },
  };
});

vi.mock('@prisma/client', () => ({ PrismaClient: vi.fn(() => prismaMock) }));
vi.mock('axios', () => ({ default: axiosMock }));

import { app, runScheduledBackups, startBackupScheduler } from './app';

const TOKEN = 'Bearer fake-jwt-token-for-alice@test.dev';
const USER = { id: 'user-1', email: 'alice@test.dev' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  prismaMock.user.findUnique.mockResolvedValue(USER);
  prismaMock.backupHistory.findMany.mockResolvedValue([]);
  prismaMock.backupHistory.create.mockResolvedValue({});
});

describe('GET /api/databases', () => {
  it('refuse une requête sans jeton', async () => {
    const res = await request(app).get('/api/databases');

    expect(res.status).toBe(401);
  });

  it("ne renvoie jamais les identifiants des bases", async () => {
    const res = await request(app).get('/api/databases').set('Authorization', TOKEN);

    expect(res.status).toBe(200);
    expect(res.body.map((db: any) => db.id)).toEqual(['safebase', 'client']);
    for (const db of res.body) {
      expect(db).not.toHaveProperty('user');
      expect(db).not.toHaveProperty('password');
    }
    expect(res.text).not.toContain('prod-secret-password');
    expect(res.text).not.toContain('client-secret-password');
  });
});

describe('POST /api/backups', () => {
  it('refuse une base inconnue sans appeler le worker', async () => {
    const res = await request(app)
      .post('/api/backups')
      .set('Authorization', TOKEN)
      .send({ database_id: 'evil', host: 'attacker.example' });

    expect(res.status).toBe(400);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  it("envoie au worker les identifiants du serveur et ignore un nom de fichier venant du client", async () => {
    axiosMock.post.mockResolvedValue({ data: { file: 'client_db_latest.sql', filePath: '/app/backups/client_db_latest.sql' } });

    const res = await request(app)
      .post('/api/backups')
      .set('Authorization', TOKEN)
      .send({ database_id: 'client', overwrite: true, custom_filename: '../evil.sql', password: 'hack' });

    expect(res.status).toBe(200);
    expect(axiosMock.post).toHaveBeenCalledWith(expect.stringMatching(/\/backup$/), {
      host: 'postgres-client',
      port: 5432,
      db_name: 'client_db',
      user: 'client_user',
      password: 'client-secret-password',
      custom_filename: 'client_db_latest.sql',
    });
    expect(prismaMock.backupHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: USER.id, status: 'Réussi', fileName: 'client_db_latest.sql' }),
    });
  });

  it("enregistre l'échec dans l'historique quand le worker échoue", async () => {
    axiosMock.post.mockRejectedValue({ message: 'boom', response: { data: { error: 'Backup failed: exit status 1' } } });

    const res = await request(app)
      .post('/api/backups')
      .set('Authorization', TOKEN)
      .send({ database_id: 'client', overwrite: false });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Backup failed: exit status 1');
    expect(prismaMock.backupHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: USER.id, dbName: 'client_db', status: 'Échec' }),
    });
  });
});

describe('POST /api/restores', () => {
  it("refuse de restaurer la base de l'application", async () => {
    const res = await request(app)
      .post('/api/restores')
      .set('Authorization', TOKEN)
      .send({ database_id: 'safebase', file_name: 'safebase_db_20261022_030000.sql' });

    expect(res.status).toBe(400);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  it("refuse un fichier absent de l'historique de l'utilisateur, sans appeler le worker", async () => {
    prismaMock.backupHistory.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/restores')
      .set('Authorization', TOKEN)
      .send({ database_id: 'client', file_name: 'client_db_20261022_030000.sql' });

    expect(res.status).toBe(403);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  it("ne cherche que les sauvegardes réussies de cette base, de l'utilisateur ou planifiées", async () => {
    prismaMock.backupHistory.findFirst.mockResolvedValue(null);

    await request(app)
      .post('/api/restores')
      .set('Authorization', TOKEN)
      .send({ database_id: 'client', file_name: 'client_db_20261022_030000.sql' });

    expect(prismaMock.backupHistory.findFirst).toHaveBeenCalledWith({
      where: {
        OR: [{ userId: USER.id }, { userId: null }],
        fileName: 'client_db_20261022_030000.sql',
        dbName: 'client_db',
        status: 'Réussi',
      },
    });
  });

  it("restaure un fichier autorisé et l'enregistre dans l'historique", async () => {
    prismaMock.backupHistory.findFirst.mockResolvedValue({ id: 'h1' });
    axiosMock.post.mockResolvedValue({ data: { status: 'success' } });

    const res = await request(app)
      .post('/api/restores')
      .set('Authorization', TOKEN)
      .send({ database_id: 'client', file_name: 'client_db_20261022_030000.sql' });

    expect(res.status).toBe(200);
    expect(axiosMock.post).toHaveBeenCalledWith(expect.stringMatching(/\/restore$/), {
      host: 'postgres-client',
      port: 5432,
      db_name: 'client_db',
      user: 'client_user',
      password: 'client-secret-password',
      filename: 'client_db_20261022_030000.sql',
    });
    expect(prismaMock.backupHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: USER.id, status: 'Restauré' }),
    });
  });
});

describe('sauvegardes planifiées', () => {
  it("sauvegarde toutes les bases même si l'une échoue, sans utilisateur", async () => {
    axiosMock.post
      .mockRejectedValueOnce(new Error('safebase_db indisponible'))
      .mockResolvedValueOnce({ data: { file: 'client_db_20261022_030000.sql' } });

    await expect(runScheduledBackups()).resolves.toBeUndefined();

    expect(axiosMock.post).toHaveBeenCalledTimes(2);
    const statuses = prismaMock.backupHistory.create.mock.calls.map(([arg]) => [arg.data.dbName, arg.data.status, arg.data.userId]);
    expect(statuses).toEqual([
      ['safebase_db', 'Échec', null],
      ['client_db', 'Réussi', null],
    ]);
  });

  it('ne planifie rien si BACKUP_CRON est vide ou invalide', () => {
    expect(startBackupScheduler(undefined)).toBe(false);
    expect(startBackupScheduler('')).toBe(false);
    expect(startBackupScheduler('tous les jours')).toBe(false);
  });
});
