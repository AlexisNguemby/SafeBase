// Configuration Google Drive
export const GOOGLE_CLIENT_ID = '405462487545-l640iptv7ms67mseneundaq5iogcqmlc.apps.googleusercontent.com';
export const GOOGLE_API_KEY = 'AIzaSyB931OQXgJGjVhWfFZDlLkKzYxwNtRbCmE';
export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

// Configuration des autorisations
export const GOOGLE_DRIVE_CONFIG = {
  clientId: GOOGLE_CLIENT_ID,
  apiKey: GOOGLE_API_KEY,
  scope: GOOGLE_SCOPE,
  discoveryDocs: ['https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'],
};