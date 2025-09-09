// Quick test to invoke run-plan function
import { supabase } from "./src/integrations/supabase/client.js";

async function testLogin() {
  try {
    const { data, error } = await supabase.functions.invoke('run-plan', {
      body: { 
        plan_id: '39c8a311-54ed-49b2-a599-266f1b7a6c36' 
      }
    });
    
    console.log('Test login result:', data);
    if (error) console.error('Error:', error);
  } catch (err) {
    console.error('Function call error:', err);
  }
}

testLogin();