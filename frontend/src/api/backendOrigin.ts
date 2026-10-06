/** The Python backend, on port 8000 of whichever machine served this page:
 *  localhost when opened locally, the host's LAN IP when opened from another
 *  device (vite --host). The VITE_*_URL env vars still override each route. */
export const BACKEND_ORIGIN = `${window.location.protocol}//${window.location.hostname}:8000`;
