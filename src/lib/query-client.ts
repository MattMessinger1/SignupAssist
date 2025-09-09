import { QueryClient } from "@tanstack/react-query";

// Create a stable query client instance
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});