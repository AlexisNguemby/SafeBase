import { app, startBackupScheduler } from './app';

const PORT = process.env.PORT || 3000;

startBackupScheduler(process.env.BACKUP_CRON);

app.listen(PORT, () => {
  console.log(`Server Node.js running on port ${PORT}`);
});
