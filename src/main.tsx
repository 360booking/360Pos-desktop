import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import './styles/globals.css';

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
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
