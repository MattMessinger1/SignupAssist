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

// Debug environment variables
console.log('VITE_SUPABASE_URL:', import.meta.env.VITE_SUPABASE_URL);
console.log('VITE_SUPABASE_ANON_KEY present:', !!import.meta.env.VITE_SUPABASE_ANON_KEY);
console.log('All env vars:', import.meta.env);

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl) {
  throw new Error('VITE_SUPABASE_URL environment variable is missing. Please check your Supabase integration.');
}

if (!supabaseAnonKey) {
  throw new Error('VITE_SUPABASE_ANON_KEY environment variable is missing. Please check your Supabase integration.');
}

export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey);