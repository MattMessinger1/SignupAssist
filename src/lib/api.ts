const API_BASE = import.meta.env.VITE_API_BASE;

export async function runPlan(plan_id: string, token: string) {
  const url = `${API_BASE}/run-plan`;
  console.debug("Calling run-plan at:", url, "with plan_id:", plan_id);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ plan_id }),
    });

    if (!response.ok) {
      console.error("run-plan error:", response.status, response.statusText);
    }
    return response;
  } catch (err) {
    console.error("run-plan fetch failed:", err);
    throw err;
  }
}