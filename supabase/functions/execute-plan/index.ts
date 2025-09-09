import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface BrowserbaseSession {
  id: string;
  status: string;
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Authorization required' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { plan_id } = await req.json();

    if (!plan_id) {
      return new Response(
        JSON.stringify({ error: 'plan_id is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Starting plan execution for plan_id: ${plan_id}`);

    // Log the start of execution
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: 'Execution phase started - loading plan and credentials...'
    });

    // Get plan details with auth check
    const { data: { user } } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
    if (!user) {
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: 'Error: Authentication failed'
      });
      return new Response(
        JSON.stringify({ error: 'Authentication failed' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { data: plan, error: planError } = await supabase
      .from('plans')
      .select('*')
      .eq('id', plan_id)
      .eq('user_id', user.id)
      .maybeSingle();

    if (planError || !plan) {
      const errorMsg = 'Plan not found or access denied';
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: `Error: ${errorMsg}`
      });
      
      return new Response(
        JSON.stringify({ error: errorMsg }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get decrypted credentials
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: 'Retrieving account credentials...'
    });

    const { data: credentialResponse, error: credError } = await supabase
      .functions
      .invoke('cred-get', {
        body: { credential_id: plan.credential_id },
        headers: { Authorization: authHeader }
      });

    if (credError || !credentialResponse?.success) {
      const errorMsg = 'Failed to retrieve credentials';
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: `Error: ${errorMsg}`
      });
      
      return new Response(
        JSON.stringify({ error: errorMsg }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const credentials = credentialResponse.data;
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: `Using account: ${credentials.alias} (${credentials.email})`
    });

    // Start Browserbase session
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: 'Starting browser session for execution...'
    });

    const browserbaseApiKey = Deno.env.get('BROWSERBASE_API_KEY');
    const browserbaseProjectId = Deno.env.get('BROWSERBASE_PROJECT_ID');
    
    if (!browserbaseApiKey || !browserbaseProjectId) {
      const errorMsg = 'Browserbase configuration missing';
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: `Error: ${errorMsg}`
      });
      
      return new Response(
        JSON.stringify({ error: errorMsg }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Create Browserbase session
    const sessionResponse = await fetch('https://www.browserbase.com/v1/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${browserbaseApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        projectId: browserbaseProjectId
      })
    });

    if (!sessionResponse.ok) {
      const errorMsg = 'Failed to create browser session';
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: `Error: ${errorMsg}`
      });
      
      return new Response(
        JSON.stringify({ error: errorMsg }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const session: BrowserbaseSession = await sessionResponse.json();
    
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: `Browser session created: ${session.id}`
    });

    try {
      // Execute the booking flow
      const result = await executeBookingFlow(
        session.id, 
        browserbaseApiKey, 
        plan, 
        credentials,
        supabase
      );

      // Update plan status based on result
      if (result.success) {
        await supabase.from('plans')
          .update({ status: result.status })
          .eq('id', plan_id);

        await supabase.from('plan_logs').insert({
          plan_id,
          msg: result.message
        });
      }

      // Close browser session
      await fetch(`https://www.browserbase.com/v1/sessions/${session.id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${browserbaseApiKey}`,
        }
      });

      await supabase.from('plan_logs').insert({
        plan_id,
        msg: 'Browser session closed - execution complete'
      });

      return new Response(
        JSON.stringify({ success: true, plan_id, status: result.status }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );

    } catch (error) {
      // Close browser session on error
      await fetch(`https://www.browserbase.com/v1/sessions/${session.id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${browserbaseApiKey}`,
        }
      });

      await supabase.from('plan_logs').insert({
        plan_id,
        msg: `Execution error: ${error.message}`
      });
      
      return new Response(
        JSON.stringify({ error: `Execution error: ${error.message}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

  } catch (error) {
    console.error('Error in execute-plan function:', error);
    
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

// Main booking flow execution
async function executeBookingFlow(sessionId: string, apiKey: string, plan: any, credentials: any, supabase: any) {
  try {
    // Step 1: Navigate to discovered URL or fallback to dashboard
    let targetUrl = plan.discovered_url || `${plan.base_url}/dashboard`;
    
    await supabase.from('plan_logs').insert({
      plan_id: plan.id,
      msg: `Navigating to: ${targetUrl}`
    });

    const navigateResponse = await fetch(`https://www.browserbase.com/v1/sessions/${sessionId}/navigate`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: targetUrl })
    });

    if (!navigateResponse.ok) {
      throw new Error('Failed to navigate to target URL');
    }

    // Wait for page load
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Step 2: Find and click preferred slot
    await supabase.from('plan_logs').insert({
      plan_id: plan.id,
      msg: `Searching for preferred slot: ${plan.preferred}`
    });

    const preferredFound = await findAndClickElement(sessionId, apiKey, plan.preferred, 'preferred slot');
    
    if (!preferredFound) {
      await supabase.from('plan_logs').insert({
        plan_id: plan.id,
        msg: `Preferred slot "${plan.preferred}" not found, checking alternate options`
      });

      // Try alternate if preferred not found
      if (plan.alternate) {
        const alternateFound = await findAndClickElement(sessionId, apiKey, plan.alternate, 'alternate slot');
        if (!alternateFound) {
          throw new Error('Neither preferred nor alternate slot found');
        }
      } else {
        throw new Error('Preferred slot not found and no alternate specified');
      }
    }

    // Wait for program page to load
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Step 3: Check for child selector and select child name
    await supabase.from('plan_logs').insert({
      plan_id: plan.id,
      msg: `Looking for child selector for: ${plan.child_name}`
    });

    const childSelected = await selectChildIfVisible(sessionId, apiKey, plan.child_name);
    if (childSelected) {
      await supabase.from('plan_logs').insert({
        plan_id: plan.id,
        msg: `Child "${plan.child_name}" selected successfully`
      });
    }

    // Step 4: Add to cart
    await supabase.from('plan_logs').insert({
      plan_id: plan.id,
      msg: 'Looking for Add/Register/Cart button...'
    });

    const cartButtons = ['Add', 'Register', 'Cart', 'Add to Cart', 'Enroll'];
    let cartSuccess = false;

    for (const buttonText of cartButtons) {
      if (await findAndClickElement(sessionId, apiKey, buttonText, 'cart button')) {
        cartSuccess = true;
        break;
      }
    }

    if (!cartSuccess) {
      throw new Error('No Add/Register/Cart button found');
    }

    // Wait and navigate to cart
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Try to navigate to cart page
    const cartUrl = `${plan.base_url}/cart`;
    await fetch(`https://www.browserbase.com/v1/sessions/${sessionId}/navigate`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: cartUrl })
    });

    await new Promise(resolve => setTimeout(resolve, 2000));

    // Step 5: Verify preferred item is in cart
    await supabase.from('plan_logs').insert({
      plan_id: plan.id,
      msg: 'Checking if preferred item is in cart...'
    });

    const preferredInCart = await verifyItemInCart(sessionId, apiKey, plan.preferred);
    
    if (!preferredInCart) {
      await supabase.from('plan_logs').insert({
        plan_id: plan.id,
        msg: 'Preferred item not found in cart - may have failed to add'
      });
      throw new Error('Preferred item not in cart');
    }

    await supabase.from('plan_logs').insert({
      plan_id: plan.id,
      msg: 'Preferred item confirmed in cart'
    });

    // Step 6: Proceed to checkout and handle CVV
    await supabase.from('plan_logs').insert({
      plan_id: plan.id,
      msg: 'Proceeding to checkout...'
    });

    const checkoutResult = await handleCheckoutWithCVV(sessionId, apiKey, plan, credentials, supabase);
    
    return checkoutResult;

  } catch (error) {
    return {
      success: false,
      status: 'failed',
      message: `Execution failed: ${error.message}`
    };
  }
}

// Helper function to find and click an element
async function findAndClickElement(sessionId: string, apiKey: string, text: string, elementType: string): Promise<boolean> {
  try {
    // Get page content
    const contentResponse = await fetch(`https://www.browserbase.com/v1/sessions/${sessionId}/content`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      }
    });

    if (!contentResponse.ok) return false;

    const content = await contentResponse.text();
    const textFound = content.toLowerCase().includes(text.toLowerCase());

    if (!textFound) return false;

    // Try multiple selector strategies
    const selectors = [
      `*:contains("${text}")`,
      `button:contains("${text}")`,
      `a:contains("${text}")`,
      `[data-testid*="${text.toLowerCase()}"]`,
      `[class*="${text.toLowerCase()}"]`,
      `[id*="${text.toLowerCase()}"]`
    ];

    for (const selector of selectors) {
      try {
        const clickResponse = await fetch(`https://www.browserbase.com/v1/sessions/${sessionId}/click`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ selector })
        });

        if (clickResponse.ok) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          return true;
        }
      } catch (e) {
        // Continue to next selector
      }
    }

    return false;
  } catch (error) {
    return false;
  }
}

// Helper function to select child if visible
async function selectChildIfVisible(sessionId: string, apiKey: string, childName: string): Promise<boolean> {
  try {
    // Check for common child selector patterns
    const selectors = [
      'select[name*="child"]',
      'select[id*="child"]',
      'select[class*="child"]',
      'select[name*="participant"]',
      'select[id*="participant"]'
    ];

    for (const selector of selectors) {
      try {
        // Try to select the child
        const selectResponse = await fetch(`https://www.browserbase.com/v1/sessions/${sessionId}/select`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            selector,
            value: childName
          })
        });

        if (selectResponse.ok) {
          return true;
        }
      } catch (e) {
        // Continue to next selector
      }
    }

    return false;
  } catch (error) {
    return false;
  }
}

// Helper function to verify item is in cart
async function verifyItemInCart(sessionId: string, apiKey: string, itemText: string): Promise<boolean> {
  try {
    const contentResponse = await fetch(`https://www.browserbase.com/v1/sessions/${sessionId}/content`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      }
    });

    if (!contentResponse.ok) return false;

    const content = await contentResponse.text();
    return content.toLowerCase().includes(itemText.toLowerCase());
  } catch (error) {
    return false;
  }
}

// Helper function to handle checkout with CVV
async function handleCheckoutWithCVV(sessionId: string, apiKey: string, plan: any, credentials: any, supabase: any) {
  try {
    // Look for checkout button
    const checkoutButtons = ['Checkout', 'Complete Order', 'Pay Now', 'Submit Order', 'Continue'];
    let checkoutClicked = false;

    for (const buttonText of checkoutButtons) {
      if (await findAndClickElement(sessionId, apiKey, buttonText, 'checkout button')) {
        checkoutClicked = true;
        await supabase.from('plan_logs').insert({
          plan_id: plan.id,
          msg: `Clicked ${buttonText} button`
        });
        break;
      }
    }

    if (!checkoutClicked) {
      return {
        success: false,
        status: 'failed',
        message: 'No checkout button found'
      };
    }

    // Wait for payment page
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Check if CVV is required
    const cvvRequired = await checkIfCVVRequired(sessionId, apiKey);
    
    if (cvvRequired) {
      await supabase.from('plan_logs').insert({
        plan_id: plan.id,
        msg: 'CVV field detected on payment page'
      });

      if (credentials.cvv) {
        // Fill CVV and continue
        const cvvFilled = await fillCVV(sessionId, apiKey, credentials.cvv);
        
        if (cvvFilled) {
          await supabase.from('plan_logs').insert({
            plan_id: plan.id,
            msg: 'CVV supplied and filled'
          });

          // Submit payment
          await new Promise(resolve => setTimeout(resolve, 1000));
          const submitSuccess = await findAndClickElement(sessionId, apiKey, 'Submit', 'submit button') ||
                               await findAndClickElement(sessionId, apiKey, 'Pay', 'pay button') ||
                               await findAndClickElement(sessionId, apiKey, 'Complete', 'complete button');

          if (submitSuccess) {
            // Wait for completion
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            // Check for success indicators
            const success = await checkPaymentSuccess(sessionId, apiKey);
            
            if (success) {
              return {
                success: true,
                status: 'success',
                message: 'Checkout completed successfully'
              };
            }
          }
        }
      } else {
        // CVV not available - require user action
        await supabase.from('plan_logs').insert({
          plan_id: plan.id,
          msg: 'CVV required but not available - waiting for user action'
        });

        // TODO: Create challenge system and send SMS
        // For now, set status to action_required
        return {
          success: true,
          status: 'action_required',
          message: 'CVV required - user action needed'
        };
      }
    } else {
      // No CVV required, try to complete checkout
      await new Promise(resolve => setTimeout(resolve, 2000));
      const success = await checkPaymentSuccess(sessionId, apiKey);
      
      if (success) {
        return {
          success: true,
          status: 'success',
          message: 'Checkout completed successfully'
        };
      }
    }

    return {
      success: false,
      status: 'failed',
      message: 'Checkout process failed'
    };

  } catch (error) {
    return {
      success: false,
      status: 'failed',
      message: `Checkout error: ${error.message}`
    };
  }
}

// Helper function to check if CVV is required
async function checkIfCVVRequired(sessionId: string, apiKey: string): Promise<boolean> {
  try {
    const contentResponse = await fetch(`https://www.browserbase.com/v1/sessions/${sessionId}/content`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      }
    });

    if (!contentResponse.ok) return false;

    const content = await contentResponse.text();
    const cvvKeywords = ['cvv', 'cvc', 'security code', 'card verification'];
    
    return cvvKeywords.some(keyword => 
      content.toLowerCase().includes(keyword)
    );
  } catch (error) {
    return false;
  }
}

// Helper function to fill CVV
async function fillCVV(sessionId: string, apiKey: string, cvv: string): Promise<boolean> {
  try {
    const selectors = [
      'input[name*="cvv"]',
      'input[id*="cvv"]',
      'input[name*="cvc"]',
      'input[id*="cvc"]',
      'input[name*="security"]',
      'input[placeholder*="CVV"]',
      'input[placeholder*="CVC"]'
    ];

    for (const selector of selectors) {
      try {
        const typeResponse = await fetch(`https://www.browserbase.com/v1/sessions/${sessionId}/type`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            selector,
            text: cvv
          })
        });

        if (typeResponse.ok) {
          return true;
        }
      } catch (e) {
        // Continue to next selector
      }
    }

    return false;
  } catch (error) {
    return false;
  }
}

// Helper function to check payment success
async function checkPaymentSuccess(sessionId: string, apiKey: string): Promise<boolean> {
  try {
    const contentResponse = await fetch(`https://www.browserbase.com/v1/sessions/${sessionId}/content`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      }
    });

    if (!contentResponse.ok) return false;

    const content = await contentResponse.text();
    const successKeywords = [
      'success', 'complete', 'confirmed', 'thank you', 
      'registration complete', 'order complete', 'payment successful'
    ];
    
    return successKeywords.some(keyword => 
      content.toLowerCase().includes(keyword)
    );
  } catch (error) {
    return false;
  }
}