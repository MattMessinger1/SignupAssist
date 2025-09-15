import { supabase } from "@/integrations/supabase/client";

export async function runPlan(plan_id: string, token: string) {
  console.debug("Calling run-plan edge function with plan_id:", plan_id);

  try {
    const { data, error } = await supabase.functions.invoke('run-plan', {
      body: { plan_id },
      headers: { Authorization: `Bearer ${token}` }
    });

    if (error) {
      console.error("run-plan edge function error:", error);
      throw error;
    }

    return { ok: true, data };
  } catch (err) {
    console.error("run-plan edge function failed:", err);
    throw err;
  }
}