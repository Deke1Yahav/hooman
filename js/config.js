// Google Drive access for this copy of the app. These values are public by design: they only work
// from the web addresses listed in the Google Cloud project, and only with the drive.file scope
// (the app sees just the files the hooman picks or that the app itself created).
export const GOOGLE = {
  clientId: "",   // OAuth client ID (Web application), "....apps.googleusercontent.com"
  apiKey: "",     // browser API key, restricted to this site and to the Drive + Picker APIs
  appId: "",      // Cloud project number
};
export const googleReady = () => !!(GOOGLE.clientId && GOOGLE.apiKey && GOOGLE.appId);
