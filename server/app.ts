import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import axios from 'axios';
import bcrypt from 'bcryptjs';
import cron from 'node-cron';
import { PrismaClient } from '@prisma/client';

// Ce fichier définit l'application sans la démarrer : index.ts lance le serveur,
// et les tests importent `app` directement.
export const app = express();
const prisma = new PrismaClient();

// Bases cibles autorisées : les identifiants restent côté serveur.
// restorable: false pour la base de SafeBase elle-même : la restaurer effacerait
// les comptes et l'historique créés depuis la sauvegarde.
const TARGET_DATABASES = [
  {
    id: 'safebase',
    name: 'Production DB',
    host: 'postgres',
    port: 5432,
    db_name: process.env.POSTGRES_DB,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    restorable: false,
  },
  {
    id: 'client',
    name: 'Client DB',
    host: 'postgres-client',
    port: 5432,
    db_name: process.env.CLIENT_DB_NAME,
    user: process.env.CLIENT_DB_USER,
    password: process.env.CLIENT_DB_PASSWORD,
    restorable: true,
  },
];

app.use(cors());
app.use(express.json());

interface AuthRequest extends Request {
  userId?: string;
  userEmail?: string;
}

// --------------------------------------------------------------------------
// Middleware d'authentification
// --------------------------------------------------------------------------
const authenticateToken = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Accès refusé. Jeton d’authentification manquant.' });
  }

  const extractedEmail = token.replace('fake-jwt-token-for-', '');

  try {
    const user = await prisma.user.findUnique({
      where: { email: extractedEmail },
    });

    if (!user) {
      return res.status(403).json({ error: 'Utilisateur non trouvé ou jeton invalide.' });
    }

    req.userId = user.id;
    req.userEmail = user.email;
    next();
  } catch (error) {
    return res.status(500).json({ error: 'Erreur lors de la vérification de l’authentification.' });
  }
};

// --------------------------------------------------------------------------
// Routes d'authentification
// --------------------------------------------------------------------------
app.post('/api/register', async (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis.' });
  }

  try {
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ error: 'Un compte existe déjà avec cet email.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
      },
    });

    return res.status(201).json({ message: 'Compte créé avec succès.' });
  } catch (error: any) {
    console.error('Register Error:', error);
    return res.status(500).json({ error: 'Erreur lors de la création du compte.' });
  }
});

app.post('/api/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis.' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(400).json({ error: 'Email ou mot de passe incorrect.' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(400).json({ error: 'Email ou mot de passe incorrect.' });
    }

    return res.json({ token: `fake-jwt-token-for-${user.email}` });
  } catch (error: any) {
    console.error('Login Error:', error);
    return res.status(500).json({ error: 'Erreur lors de la connexion.' });
  }
});

// --------------------------------------------------------------------------
// Routes Sécurisées (Backups & Historique)
// --------------------------------------------------------------------------

const goWorkerUrl = process.env.GO_WORKER_URL || 'http://worker-go:8080';

type TargetDatabase = (typeof TARGET_DATABASES)[number];

// Historique visible par un utilisateur : ses actions + les sauvegardes planifiées (userId null)
const getHistory = (userId: string) =>
  prisma.backupHistory.findMany({
    where: { OR: [{ userId }, { userId: null }] },
    orderBy: { createdAt: 'desc' },
  });

const formatDate = () => new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });

// Lance une sauvegarde via le worker et l'enregistre dans l'historique.
// Utilisée par la route POST /api/backups (userId de l'utilisateur) et par le cron (userId null).
// En cas d'erreur, l'échec est aussi enregistré, puis l'erreur est relancée à l'appelant.
const runBackup = async (target: TargetDatabase, overwrite: boolean, userId: string | null) => {
  const customFilename = overwrite ? `${target.db_name}_latest.sql` : null;

  try {
    const response = await axios.post(`${goWorkerUrl}/backup`, {
      host: target.host,
      port: target.port,
      db_name: target.db_name,
      user: target.user,
      password: target.password,
      custom_filename: customFilename,
    });

    // Enregistrement en base de données PostgreSQL via Prisma
    await prisma.backupHistory.create({
      data: {
        userId,
        dbName: target.db_name!,
        fileName: response.data.file,
        date: formatDate(),
        status: 'Réussi',
      },
    });

    return response.data as { file: string; filePath: string };
  } catch (error) {
    await prisma.backupHistory.create({
      data: {
        userId,
        dbName: target.db_name!,
        fileName: customFilename ?? '-',
        date: formatDate(),
        status: 'Échec',
      },
    });
    throw error;
  }
};

// 1. Récupérer l'historique de l'utilisateur connecté
app.get('/api/backups/history', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userHistory = await getHistory(req.userId!);

    return res.json(userHistory);
  } catch (error) {
    return res.status(500).json({ error: 'Erreur lors de la récupération de l’historique.' });
  }
});

// 2. Lister les bases cibles (sans les identifiants)
app.get('/api/databases', authenticateToken, (req: AuthRequest, res: Response) => {
  return res.json(
    TARGET_DATABASES.map(({ id, name, host, port, db_name, restorable }) => ({
      id,
      name,
      host,
      port,
      db_name,
      restorable,
    }))
  );
});

// 3. Déclencher une sauvegarde
app.post('/api/backups', authenticateToken, async (req: AuthRequest, res: Response) => {
  const { database_id, overwrite } = req.body;

  const target = TARGET_DATABASES.find((db) => db.id === database_id);
  if (!target) {
    return res.status(400).json({ error: 'Base cible inconnue.' });
  }

  try {
    const backup = await runBackup(target, Boolean(overwrite), req.userId!);

    // Récupération de l'historique à jour
    const userHistory = await getHistory(req.userId!);

    return res.json({
      file: backup.file,
      filePath: backup.filePath,
      history: userHistory,
    });
  } catch (error: any) {
    console.error('Backup Error:', error.message);

    return res.status(500).json({
      error: error.response?.data?.error || error.message || 'Échec de la sauvegarde',
    });
  }
});

// 4. Restaurer une sauvegarde dans sa base d'origine
app.post('/api/restores', authenticateToken, async (req: AuthRequest, res: Response) => {
  const { database_id, file_name } = req.body;

  const target = TARGET_DATABASES.find((db) => db.id === database_id);
  if (!target) {
    return res.status(400).json({ error: 'Base cible inconnue.' });
  }
  if (!target.restorable) {
    return res.status(400).json({ error: 'Cette base ne peut pas être restaurée.' });
  }

  try {
    // Autorisation : on ne restaure qu'une sauvegarde réussie de cette base,
    // faite par l'utilisateur ou planifiée (userId null)
    const backup = await prisma.backupHistory.findFirst({
      where: {
        OR: [{ userId: req.userId }, { userId: null }],
        fileName: file_name,
        dbName: target.db_name,
        status: 'Réussi',
      },
    });
    if (!backup) {
      return res.status(403).json({ error: 'Sauvegarde introuvable dans votre historique.' });
    }

    await axios.post(`${goWorkerUrl}/restore`, {
      host: target.host,
      port: target.port,
      db_name: target.db_name,
      user: target.user,
      password: target.password,
      filename: file_name,
    });

    await prisma.backupHistory.create({
      data: {
        userId: req.userId!,
        dbName: target.db_name!,
        fileName: file_name,
        date: formatDate(),
        status: 'Restauré',
      },
    });

    const userHistory = await getHistory(req.userId!);

    return res.json({
      file: file_name,
      history: userHistory,
    });
  } catch (error: any) {
    console.error('Restore Error:', error.message);

    return res.status(500).json({
      error: error.response?.data?.error || error.message || 'Échec de la restauration',
    });
  }
});

// --------------------------------------------------------------------------
// Sauvegardes planifiées
// --------------------------------------------------------------------------
// Sauvegarde toutes les bases cibles, sans utilisateur (userId null).
// Un try/catch par base : l'échec de l'une n'empêche pas la sauvegarde des autres.
export const runScheduledBackups = async () => {
  for (const target of TARGET_DATABASES) {
    try {
      const backup = await runBackup(target, false, null);
      console.log(`Sauvegarde planifiée réussie : ${backup.file}`);
    } catch (error: any) {
      console.error(`Sauvegarde planifiée échouée (${target.db_name}) :`, error.message);
    }
  }
};

// Démarre la planification. L'expression suit le format cron
// "minute heure jour mois jour-de-semaine", par exemple "0 3 * * *" = tous les jours à 3h00.
// Renvoie false si l'expression est vide (planification désactivée) ou invalide.
export const startBackupScheduler = (expression: string | undefined) => {
  if (!expression) {
    return false;
  }
  if (!cron.validate(expression)) {
    console.error(`BACKUP_CRON invalide ("${expression}") : aucune sauvegarde planifiée.`);
    return false;
  }

  // noOverlap : si la tâche précédente tourne encore, on saute ce déclenchement
  cron.schedule(expression, runScheduledBackups, { noOverlap: true });
  console.log(`Sauvegardes planifiées actives (BACKUP_CRON="${expression}")`);
  return true;
};
