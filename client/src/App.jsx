import { useState, useEffect } from 'react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// Couleur affichée pour chaque statut de l'historique
const STATUS_COLORS = {
  'Réussi': 'green',
  'Restauré': '#007bff',
  'Échec': '#dc3545',
};

function App() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState(localStorage.getItem('token') || '');

  const [databases, setDatabases] = useState([]);
  const [selectedDbId, setSelectedDbId] = useState('');
  const [status, setStatus] = useState('');
  const [history, setHistory] = useState([]);

  // Récupérer l'historique uniquement si l'utilisateur possède un token
  const fetchHistory = (authToken) => {
    fetch(`${API_URL}/api/backups/history`, {
      headers: { 
        'Authorization': `Bearer ${authToken}` 
      }
    })
      .then((res) => {
        if (!res.ok) throw new Error('Non autorisé');
        return res.json();
      })
      .then((data) => setHistory(data))
      .catch(() => setHistory([]));
  };

  // Récupérer les bases cibles (le serveur ne renvoie pas les identifiants)
  const fetchDatabases = (authToken) => {
    fetch(`${API_URL}/api/databases`, {
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    })
      .then((res) => {
        if (!res.ok) throw new Error('Non autorisé');
        return res.json();
      })
      .then((data) => {
        setDatabases(data);
        if (data.length > 0) setSelectedDbId(data[0].id);
      })
      .catch(() => setDatabases([]));
  };

  useEffect(() => {
    if (token) {
      fetchHistory(token);
      fetchDatabases(token);
    }
  }, [token]);

  const dbConfig = databases.find((db) => db.id === selectedDbId);

  const handleAuth = async (endpoint) => {
    setStatus('Processing authentication...');
    try {
      const res = await fetch(`${API_URL}/api/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || 'Auth failed');

      if (data.token) {
        setToken(data.token);
        localStorage.setItem('token', data.token);
        setStatus('Logged in successfully!');
      } else {
        setStatus('Account created! Now you can log in.');
      }
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    }
  };

  const handleLogout = () => {
    setToken('');
    localStorage.removeItem('token');
    setHistory([]);
    setStatus('Logged out successfully.');
  };

  // Restauration d'une sauvegarde de l'historique dans sa base d'origine
  const handleRestore = async (item) => {
    const target = databases.find((db) => db.db_name === item.dbName);
    if (!target) return;

    // Action destructrice : on demande confirmation avant d'écraser les données
    const confirmed = window.confirm(
      `Restaurer ${item.fileName} sur ${target.db_name} ?\nLes données actuelles de la base seront remplacées.`
    );
    if (!confirmed) return;

    setStatus(`Restoring ${item.fileName}...`);
    try {
      const res = await fetch(`${API_URL}/api/restores`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ database_id: target.id, file_name: item.fileName }),
      });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || 'Restore failed');

      setStatus(`Restore successful! ${data.file} restored on ${target.db_name}`);
      setHistory(data.history);
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    }
  };

  // Une ligne est restaurable si la sauvegarde a réussi et que sa base l'autorise
  const isRestorable = (item) =>
    item.status === 'Réussi' &&
    databases.some((db) => db.db_name === item.dbName && db.restorable);

  // Déclencheur de backup (requiert d'être authentifié)
  const handleBackup = async (shouldOverwrite = false) => {
    if (!token) {
      setStatus('Error: You must be logged in to trigger a backup.');
      return;
    }

    if (!dbConfig) {
      setStatus('Error: No target database selected.');
      return;
    }

    setStatus(`Triggering backup for ${dbConfig.db_name}...`);
    try {
      const payload = {
        database_id: selectedDbId,
        overwrite: shouldOverwrite,
      };

      const res = await fetch(`${API_URL}/api/backups`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || 'Backup failed');

      setStatus(`Backup successful! File saved: ${data.file}`);
      if (data.history) {
        setHistory(data.history);
      } else {
        fetchHistory(token);
      }
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    }
  };

  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif', maxWidth: '700px', margin: '0 auto' }}>
      <h1>SafeBase MVP</h1>

      {/* Auth Section */}
      <div style={{ border: '1px solid #ccc', padding: '15px', marginBottom: '15px', borderRadius: '8px' }}>
        <h2>1. Authentication</h2>
        {token ? (
          <div>
            <p style={{ color: 'green', fontWeight: 'bold' }}>✓ Authenticated</p>
            <button 
              onClick={handleLogout} 
              style={{ padding: '8px 12px', background: '#dc3545', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
            >
              Logout
            </button>
          </div>
        ) : (
          <div>
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{ display: 'block', marginBottom: '10px', width: '100%', padding: '8px' }}
            />
            <input
              type="password"
              placeholder="Password (min 8 chars)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{ display: 'block', marginBottom: '10px', width: '100%', padding: '8px' }}
            />
            <button onClick={() => handleAuth('register')} style={{ marginRight: '10px', padding: '8px 12px' }}>
              Register
            </button>
            <button onClick={() => handleAuth('login')} style={{ padding: '8px 12px' }}>
              Login
            </button>
          </div>
        )}
      </div>

      {/* Status Box */}
      {status && (
        <div style={{ padding: '10px', background: '#f0f0f0', borderLeft: '4px solid #007bff', marginBottom: '15px' }}>
          <strong>Status:</strong> {status}
        </div>
      )}

      {/* Sections affichées uniquement si l'utilisateur est connecté */}
      {token ? (
        <>
          {/* Backup Section */}
          <div style={{ border: '1px solid #ccc', padding: '15px', borderRadius: '8px', marginBottom: '15px' }}>
            <h2>2. Target Database & Backup</h2>
            
            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>
                Sélectionner la base de données cible :
              </label>
              <select 
                value={selectedDbId}
                onChange={(e) => setSelectedDbId(e.target.value)}
                style={{ width: '100%', padding: '8px', fontSize: '14px' }}
              >
                {databases.map((db) => (
                  <option key={db.id} value={db.id}>
                    {db.name} ({db.db_name}) ({db.host}:{db.port})
                  </option>
                ))}
              </select>
            </div>

            {dbConfig && (
              <>
                <p><strong>Host:</strong> {dbConfig.host}:{dbConfig.port}</p>
                <p><strong>Database:</strong> {dbConfig.db_name}</p>
              </>
            )}
            
            <div style={{ display: 'flex', gap: '10px' }}>
              <button 
                onClick={() => handleBackup(false)} 
                style={{ padding: '10px 15px', background: '#007bff', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
              >
                Sauvegarde Horodatée (Historique)
              </button>

              <button 
                onClick={() => handleBackup(true)} 
                style={{ padding: '10px 15px', background: '#28a745', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
              >
                Sauvegarder et Écraser ({dbConfig?.db_name}_latest.sql)
              </button>
            </div>
          </div>

          {/* Historique des sauvegardes */}
          <div style={{ border: '1px solid #ccc', padding: '15px', borderRadius: '8px' }}>
            <h2>3. Historique des Sauvegardes</h2>
            {history.length === 0 ? (
              <p>Aucune sauvegarde effectuée pour le moment.</p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid #ccc' }}>
                    <th style={{ padding: '8px' }}>Base</th>
                    <th style={{ padding: '8px' }}>Fichier SQL</th>
                    <th style={{ padding: '8px' }}>Date</th>
                    <th style={{ padding: '8px' }}>Statut</th>
                    <th style={{ padding: '8px' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((item, index) => (
                    <tr key={index} style={{ borderBottom: '1px solid #eee' }}>
                      <td style={{ padding: '8px' }}>{item.dbName}</td>
                      <td style={{ padding: '8px' }}>
                        <code>{item.fileName}</code>
                        {/* userId null = sauvegarde lancée par la planification */}
                        {item.userId === null && <em style={{ color: '#666' }}> (auto)</em>}
                      </td>
                      <td style={{ padding: '8px' }}>{item.date}</td>
                      <td style={{ padding: '8px', color: STATUS_COLORS[item.status] || 'inherit', fontWeight: 'bold' }}>{item.status}</td>
                      <td style={{ padding: '8px' }}>
                        {isRestorable(item) && (
                          <button
                            onClick={() => handleRestore(item)}
                            style={{ padding: '4px 8px', background: '#ffc107', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
                          >
                            Restaurer
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      ) : (
        <div style={{ padding: '15px', border: '1px dashed #ffa000', backgroundColor: '#fff8e1', borderRadius: '8px', color: '#b78103' }}>
          🔒 Veuillez vous connecter pour accéder aux outils de sauvegarde et à l'historique.
        </div>
      )}
    </div>
  );
}

export default App;