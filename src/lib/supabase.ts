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

export const supabase = createClient<Database>(
  import.meta.env.VITE_SUPABASE_URL!,
  import.meta.env.VITE_SUPABASE_ANON_KEY!
);