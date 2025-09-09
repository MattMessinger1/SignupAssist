export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "13.0.5"
  }
  public: {
    Tables: {
      account_credentials: {
        Row: {
          alias: string
          created_at: string | null
          cvv_enc: string | null
          email_enc: string
          id: string
          password_enc: string
          provider_slug: string
          user_id: string
        }
        Insert: {
          alias: string
          created_at?: string | null
          cvv_enc?: string | null
          email_enc: string
          id?: string
          password_enc: string
          provider_slug: string
          user_id: string
        }
        Update: {
          alias?: string
          created_at?: string | null
          cvv_enc?: string | null
          email_enc?: string
          id?: string
          password_enc?: string
          provider_slug?: string
          user_id?: string
        }
        Relationships: []
      }
      challenges: {
        Row: {
          created_at: string | null
          data: Json | null
          expires_at: string
          plan_id: string
          status: string
          token: string
          type: string
        }
        Insert: {
          created_at?: string | null
          data?: Json | null
          expires_at: string
          plan_id: string
          status?: string
          token: string
          type: string
        }
        Update: {
          created_at?: string | null
          data?: Json | null
          expires_at?: string
          plan_id?: string
          status?: string
          token?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "challenges_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["id"]
          },
        ]
      }
      plan_logs: {
        Row: {
          at: string | null
          id: number
          msg: string
          plan_id: string
        }
        Insert: {
          at?: string | null
          id?: number
          msg: string
          plan_id: string
        }
        Update: {
          at?: string | null
          id?: number
          msg?: string
          plan_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "plan_logs_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["id"]
          },
        ]
      }
      plans: {
        Row: {
          alternate: string | null
          alternate_class_name: string | null
          base_url: string
          child_name: string
          created_at: string | null
          credential_id: string
          discovered_url: string | null
          id: string
          open_time: string
          org: string
          paid: boolean
          phone: string | null
          preferred: string
          preferred_class_name: string | null
          provider_slug: string
          status: string
          status_updated_at: string | null
          user_id: string
        }
        Insert: {
          alternate?: string | null
          alternate_class_name?: string | null
          base_url: string
          child_name: string
          created_at?: string | null
          credential_id: string
          discovered_url?: string | null
          id?: string
          open_time: string
          org: string
          paid?: boolean
          phone?: string | null
          preferred: string
          preferred_class_name?: string | null
          provider_slug?: string
          status?: string
          status_updated_at?: string | null
          user_id: string
        }
        Update: {
          alternate?: string | null
          alternate_class_name?: string | null
          base_url?: string
          child_name?: string
          created_at?: string | null
          credential_id?: string
          discovered_url?: string | null
          id?: string
          open_time?: string
          org?: string
          paid?: boolean
          phone?: string | null
          preferred?: string
          preferred_class_name?: string | null
          provider_slug?: string
          status?: string
          status_updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "plans_credential_id_fkey"
            columns: ["credential_id"]
            isOneToOne: false
            referencedRelation: "account_credentials"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
