const API_BASE = import.meta.env.VITE_API_BASE;

export async function runPlan(plan_id: string, token: string) {
  return fetch(`${API_BASE}/run-plan`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({ plan_id }),
  });
}