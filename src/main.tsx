import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { FiscalWindow } from './shell/FiscalWindow';
import { OfflineTill } from './shell/OfflineTill';
import { StationSetup } from './shell/StationSetup';
import './styles/globals.css';

// Etapa 5 — the desktop shell opens bundled pages with `?shell=<view>`
// (src-tauri/src/shell/mod.rs::local_view). No param = the legacy POS UI.
function pickRoot(): React.ComponentType {
  const view = new URLSearchParams(window.location.search).get('shell');
  switch (view) {
    case 'offline':
      return OfflineTill;
    case 'fiscal':
      return FiscalWindow;
    case 'setup':
      return StationSetup;
    default:
      return App;
  }
}
const Root = pickRoot();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // POS UI must stay snappy even when the network blips — we never
      // throw away cached data on background refetch failure.
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 5_000,
    },
    mutations: {
      // Mutations are wrapped by the sync engine; never auto-retry at
      // the React Query layer because that would bypass mutation_id
      // dedup guarantees.
      retry: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <Root />
    </QueryClientProvider>
  </React.StrictMode>,
);
