import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../ui/theme.css';
import '../ui/desktop.css';
import './app.css';
import { injectLogoCss } from '../ui/injectLogoCss';
import { Toaster } from '../lib/toast';
import { DialogHost } from '../lib/dialog';
import { releaseBootWhenReady } from '../ui/loading';
import { HyperfocusApp } from './App';

injectLogoCss();
// Data router: needed to stop leaving the page with unsaved changes (useBlocker).
const router = createBrowserRouter(
  [
    {
      path: '*',
      element: (
        <>
          <HyperfocusApp />
          <Toaster />
          <DialogHost />
        </>
      ),
    },
  ],
);
const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, retry: false, refetchOnWindowFocus: false } } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
releaseBootWhenReady(() => queryClient.isFetching() > 0);
