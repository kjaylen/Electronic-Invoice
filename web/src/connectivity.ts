/**
 * Whether what needs the server can be used right now. The web app always can;
 * an offline-first till (pos/offline) says when it cannot, so the counter
 * offers only what works without the server and says why the rest is off.
 */

import { createContext, useContext } from 'react';

export interface Connectivity {
  /** The server can be reached and knows who is signed in: gift cards, points, sales on account, email. */
  serverFeatures: boolean;
  /** The server can be reached at all. */
  online: boolean;
}

export const ConnectivityContext = createContext<Connectivity>({ serverFeatures: true, online: true });
export const useConnectivity = () => useContext(ConnectivityContext);
