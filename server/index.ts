import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import axios from 'axios';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3000;

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

  try {
    const decoded = jwt.verify(
      token, 
      process.env.JWT_SECRET || 'super_secret_jwt_key_change_me'
    ) as { email: string };

    const user = await prisma.user.findUnique({
      where: { email: decoded.email },
    });

    if (!user) {
      return res.status(403).json({ error: 'Utilisateur non trouvé ou jeton invalide.' });
    }

    req.userId = user.id;
    req.userEmail = user.email;
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Jeton d’authentification invalide.' });
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

    return res.json({ token: jwt.sign({ email: user.email }, process.env.JWT_SECRET || 'super_secret_jwt_key_change_me', { expiresIn: '24h' }) });
  } catch (error: any) {
    console.error('Login Error:', error);
    return res.status(500).json({ error: 'Erreur lors de la connexion.' });
  }
});

// --------------------------------------------------------------------------
// Routes Sécurisées (Backups & Historique)
// --------------------------------------------------------------------------

// 1. Récupérer l'historique de l'utilisateur connecté
app.get('/api/backups/history', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userHistory = await prisma.backupHistory.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: 'desc' },
    });

    return res.json(userHistory);
  } catch (error) {
    return res.status(500).json({ error: 'Erreur lors de la récupération de l’historique.' });
  }
});

// 2. Déclencher une sauvegarde
app.post('/api/backups', authenticateToken, async (req: AuthRequest, res: Response) => {
  const { host, port, db_name, user, password, custom_filename } = req.body;

  try {
    const goWorkerUrl = process.env.GO_WORKER_URL || 'http://worker-go:8080';

    const response = await axios.post(`${goWorkerUrl}/backup`, {
      host: host || 'postgres',
      port: port || 5432,
      db_name: db_name || 'safebase_db',
      user: user || 'safebase_user',
      password: password || 'safebase_password',
      custom_filename: custom_filename || null,
    });

    const formattedDate = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });

    // Enregistrement en base de données PostgreSQL via Prisma
    await prisma.backupHistory.create({
      data: {
        userId: req.userId!,
        dbName: db_name || 'safebase_db',
        fileName: response.data.file,
        date: formattedDate,
        status: 'Réussi',
      },
    });

    // Récupération de l'historique à jour
    const userHistory = await prisma.backupHistory.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({
      file: response.data.file,
      filePath: response.data.filePath,
      history: userHistory,
    });
  } catch (error: any) {
    console.error('Backup Error:', error.message);

    return res.status(500).json({
      error: error.response?.data?.error || error.message || 'Échec de la sauvegarde',
    });
  }
});

// 3. Télécharger un fichier de sauvegarde (pour Google Drive)
app.get('/api/backups/download', authenticateToken, async (req: AuthRequest, res: Response) => {
  const fileName = req.query.file as string;

  if (!fileName) {
    return res.status(400).json({ error: 'Nom de fichier manquant.' });
  }

  try {
    const goWorkerUrl = process.env.GO_WORKER_URL || 'http://worker-go:8080';
    
    // Récupération du contenu binaire auprès du worker Go
    const response = await axios.get(`${goWorkerUrl}/download?file=${encodeURIComponent(fileName)}`, {
      responseType: 'arraybuffer',
    });

    res.setHeader('Content-Type', 'application/sql');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(response.data);
  } catch (error: any) {
    console.error('Download Error:', error.message);
    return res.status(404).json({ error: 'Fichier introuvable sur le serveur de sauvegarde.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server Node.js running on port ${PORT}`);
});