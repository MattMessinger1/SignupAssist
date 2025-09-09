import { createClient } from '@supabase/supabase-js';

export type Database = {
  public: {
    Tables: {
      signup_plans: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          event_url: string;
          credentials: Record<string, any>;
          signup_time: string;
          status: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          name: string;
          event_url: string;
          credentials: Record<string, any>;
          signup_time: string;
          status?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          name?: string;
          event_url?: string;
          credentials?: Record<string, any>;
          signup_time?: string;
          status?: string;
          created_at?: string;
          updated_at?: string;
        };
      };
      signup_attempts: {
        Row: {
          id: string;
          plan_id: string;
          status: string;
          result: Record<string, any>;
          created_at: string;
        };
        Insert: {
          id?: string;
          plan_id: string;
          status: string;
          result?: Record<string, any>;
          created_at?: string;
        };
        Update: {
          id?: string;
          plan_id?: string;
          status?: string;
          result?: Record<string, any>;
          created_at?: string;
        };
      };
    };
  };
};

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Create Supabase client or mock client if environment variables are missing
let supabaseClient: any;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('⚠️ Supabase environment variables missing. Using mock client.');
  console.warn('Please activate Supabase integration using the green button in top-right corner.');
  
  // Create a mock client that won't crash the app
  supabaseClient = {
    auth: {
      getUser: () => Promise.resolve({ data: { user: null }, error: null }),
      signInWithPassword: () => Promise.resolve({ data: { user: null }, error: { message: 'Supabase not configured' } }),
      signUp: () => Promise.resolve({ data: { user: null }, error: { message: 'Supabase not configured' } }),
      signOut: () => Promise.resolve({ error: null }),
      onAuthStateChange: (callback: any) => ({
        data: { subscription: { unsubscribe: () => {} } }
      })
    },
    from: () => ({
      select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) })
    })
  };
} else {
  supabaseClient = createClient<Database>(supabaseUrl, supabaseAnonKey);
}

export const supabase = supabaseClient;