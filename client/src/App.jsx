import { useState, useEffect } from 'react';
import { GOOGLE_CLIENT_ID, GOOGLE_SCOPE } from './googleConfig';

// Liste des bases de données cibles configurables
const PRESET_DATABASES = [
  {
    name: 'Client DB (client_db)',
    host: 'postgres-client',
    port: 5432,
    db_name: 'client_db',
    user: 'client_user',
    password: 'client_password',
  }
];

function App() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState(localStorage.getItem('token') || '');

  const [dbConfig, setDbConfig] = useState(PRESET_DATABASES[0]);
  const [status, setStatus] = useState('');
  const [history, setHistory] = useState([]);
  const [googleDriveConnected, setGoogleDriveConnected] = useState(false);
  const [accessToken, setAccessToken] = useState(null);
  const [uploadingFile, setUploadingFile] = useState(null);

  // Récupérer l'historique uniquement si l'utilisateur possède un token
  const fetchHistory = (authToken) => {
    fetch('http://localhost:3000/api/backups/history', {
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

  useEffect(() => {
    if (token) {
      fetchHistory(token);
    }
  }, [token]);

  const handleAuth = async (endpoint) => {
    setStatus('Processing authentication...');
    try {
      const res = await fetch(`http://localhost:3000/api/${endpoint}`, {
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
    setGoogleDriveConnected(false);
    setAccessToken(null);
  };

  // Fonction pour envoyer un fichier spécifique vers Google Drive via bouton dédié
  const uploadToGoogleDrive = async (fileName) => {
    if (!googleDriveConnected) {
      setStatus('Erreur : Veuillez d’abord vous connecter à Google Drive dans la section 1.');
      return;
    }

    try {
      setUploadingFile(fileName);
      setStatus(`Envoi de ${fileName} vers Google Drive...`);
      
      const fileResponse = await fetch(`http://localhost:3000/api/backups/download?file=${encodeURIComponent(fileName)}`, {
        headers: { 
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (!fileResponse.ok) {
        throw new Error('Échec du téléchargement du fichier depuis le serveur');
      }
      
      const fileBlob = await fileResponse.blob();
      const sqlBlob = new Blob([fileBlob], { type: 'application/sql' });

      const currentToken = window.gapi?.client?.getToken()?.access_token || accessToken;
      if (!currentToken) {
        throw new Error('Jeton d’accès Google Drive manquant. Reconnectez-vous.');
      }

      const metadata = {
        name: fileName,
        mimeType: 'application/sql',
        parents: ['root']
      };

      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
      form.append('file', sqlBlob);

      const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST',
        headers: new Headers({ 'Authorization': 'Bearer ' + currentToken }),
        body: form,
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error?.message || 'Échec de l’envoi');
      }
      
      setStatus(`Succès ! ${result.name} a été envoyé sur Google Drive.`);
    } catch (error) {
      console.error('Google Drive upload error:', error);
      setStatus(`Erreur Google Drive : ${error.message}`);
    } finally {
      setUploadingFile(null);
    }
  };

  // Déclencheur de backup unique (écrasement du fichier latest)
  const handleBackup = async () => {
    if (!token) {
      setStatus('Error: You must be logged in to trigger a backup.');
      return;
    }

    setStatus(`Sauvegarde en cours pour ${dbConfig.db_name}...`);
    try {
      const payload = {
        ...dbConfig,
        custom_filename: `${dbConfig.db_name}_latest.sql`,
      };

      const res = await fetch('http://localhost:3000/api/backups', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || 'Backup failed');

      setStatus(`Sauvegarde réussie ! Fichier mis à jour : ${data.file}`);
      if (data.history) {
        setHistory(data.history);
      } else {
        fetchHistory(token);
      }
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    }
  };

  // Initialisation de Google API
  useEffect(() => {
    const loadGapiScript = () => {
      const script = document.createElement('script');
      script.src = 'https://apis.google.com/js/api.js';
      script.onload = () => {
        window.gapi.load('client', () => {
          window.gapi.client.init({
            discoveryDocs: ['https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'],
          }).catch((err) => console.error('GAPI client init error:', err));
        });
      };
      document.head.appendChild(script);
    };

    const loadGisScript = () => {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    };

    loadGapiScript();
    loadGisScript();
  }, []);

  const handleGoogleSignIn = () => {
    try {
      const tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: GOOGLE_SCOPE,
        callback: (response) => {
          if (response.error) {
            console.error('Google sign-in error:', response);
            setStatus('Error signing in to Google Drive');
            return;
          }
          setAccessToken(response.access_token);
          setGoogleDriveConnected(true);
          if (window.gapi?.client) {
            window.gapi.client.setToken({ access_token: response.access_token });
          }
          setStatus('Successfully connected to Google Drive!');
        },
      });
      tokenClient.requestAccessToken();
    } catch (error) {
      console.error('Google sign-in exception:', error);
      setStatus('Error signing in to Google Drive');
    }
  };

  const handleGoogleSignOut = () => {
    if (accessToken && window.google?.accounts?.oauth2) {
      window.google.accounts.oauth2.revoke(accessToken, () => {
        setGoogleDriveConnected(false);
        setAccessToken(null);
        if (window.gapi?.client) {
          window.gapi.client.setToken(null);
        }
        setStatus('Successfully signed out of Google Drive');
      });
    } else {
      setGoogleDriveConnected(false);
      setAccessToken(null);
      setStatus('Successfully signed out of Google Drive');
    }
  };

  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif', maxWidth: '800px', margin: '0 auto' }}>
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
            
            <div style={{ marginTop: '15px', paddingTop: '15px', borderTop: '1px solid #eee' }}>
              <h3>Google Drive Integration</h3>
              {googleDriveConnected ? (
                <div>
                  <p style={{ color: 'green', fontWeight: 'bold' }}>✓ Connected to Google Drive</p>
                  <button 
                    onClick={handleGoogleSignOut} 
                    style={{ padding: '8px 12px', background: '#6c757d', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
                  >
                    Disconnect from Google Drive
                  </button>
                </div>
              ) : (
                <div>
                  <p>Connect to Google Drive to upload backups manually</p>
                  <button 
                    onClick={handleGoogleSignIn} 
                    style={{ padding: '8px 12px', background: '#4285f4', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
                  >
                    Connect to Google Drive
                  </button>
                </div>
              )}
            </div>
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
            <button onClick={() => handleAuth('register')} style={{ marginRight: '10px', padding: '8px 12px', cursor: 'pointer' }}>
              Register
            </button>
            <button onClick={() => handleAuth('login')} style={{ padding: '8px 12px', cursor: 'pointer' }}>
              Login
            </button>
          </div>
        )}
      </div>

      {status && (
        <div style={{ padding: '10px', background: '#f0f0f0', borderLeft: '4px solid #007bff', marginBottom: '15px' }}>
          <strong>Status:</strong> {status}
        </div>
      )}

      {token ? (
        <>
          <div style={{ border: '1px solid #ccc', padding: '15px', borderRadius: '8px', marginBottom: '15px' }}>
            <h2>2. Target Database & Backup</h2>
            
            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>
                Sélectionner la base de données cible :
              </label>
              <select 
                onChange={(e) => setDbConfig(PRESET_DATABASES[e.target.value])}
                style={{ width: '100%', padding: '8px', fontSize: '14px' }}
              >
                {PRESET_DATABASES.map((db, index) => (
                  <option key={index} value={index}>
                    {db.name} ({db.host}:{db.port})
                  </option>
                ))}
              </select>
            </div>

            <p><strong>Host:</strong> {dbConfig.host}:{dbConfig.port}</p>
            <p><strong>Database:</strong> {dbConfig.db_name}</p>
            
            <div style={{ display: 'flex', gap: '10px' }}>
              <button 
                onClick={handleBackup} 
                style={{ padding: '10px 15px', background: '#28a745', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
              >
                Sauvegarder et Écraser ({dbConfig.db_name}_latest.sql)
              </button>
            </div>
          </div>

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
                    <th style={{ padding: '8px' }}>Action Drive</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((item, index) => (
                    <tr key={index} style={{ borderBottom: '1px solid #eee' }}>
                      <td style={{ padding: '8px' }}>{item.dbName}</td>
                      <td style={{ padding: '8px' }}><code>{item.fileName}</code></td>
                      <td style={{ padding: '8px' }}>{item.date}</td>
                      <td style={{ padding: '8px', color: 'green', fontWeight: 'bold' }}>{item.status}</td>
                      <td style={{ padding: '8px' }}>
                        <button
                          onClick={() => uploadToGoogleDrive(item.fileName)}
                          disabled={uploadingFile === item.fileName}
                          style={{
                            padding: '6px 10px',
                            background: '#4285f4',
                            color: '#fff',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontSize: '12px'
                          }}
                        >
                          {uploadingFile === item.fileName ? 'Envoi...' : '☁️ Uploader sur Drive'}
                        </button>
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