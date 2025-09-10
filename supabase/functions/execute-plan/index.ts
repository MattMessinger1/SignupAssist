import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';

// ===== POLICY CONSTANTS =====
const CAPTCHA_AUTOSOLVE_ENABLED = false; // NEVER call a CAPTCHA solver - SMS + verify link only
const PER_USER_WEEKLY_LIMIT = 3; // Maximum plans per user per 7 days  
const SMS_IMMEDIATE_ON_ACTION_REQUIRED = true; // Send SMS immediately when action required

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

    // ===== SINGLE-EXECUTION POLICY =====
    // Only execute plans with status 'scheduled' or 'action_required'
    if (plan.status !== 'scheduled' && plan.status !== 'action_required') {
      console.log(`Ignoring execution request for plan ${plan_id} with status '${plan.status}' - only 'scheduled' or 'action_required' plans can be executed`);
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: `Execution ignored - plan status is '${plan.status}' (only 'scheduled' or 'action_required' plans can be executed)`
      });
      
      return new Response(
        JSON.stringify({ 
          success: false, 
          message: `Plan execution ignored - status is '${plan.status}'`,
          current_status: plan.status
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Log the start of execution
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: 'Execution phase started - loading plan and credentials...'
    });

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

    // Handle legacy plans without payment authorization fields
    const expectedCost = plan.expected_lesson_cost || 50; // Default reasonable amount for legacy plans
    const maxChargeLimit = plan.max_charge_limit || 100; // Default safety limit for legacy plans
    
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: `Payment authorization: Expected cost: $${expectedCost}, Max limit: $${maxChargeLimit}`
    });

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
    const sessionResponse = await fetch('https://api.browserbase.com/v1/sessions', {
      method: 'POST',
      headers: {
        'X-BB-API-Key': browserbaseApiKey,
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

    let session: BrowserbaseSession;
    try {
      session = await sessionResponse.json();
    } catch (err) {
      const text = await sessionResponse.text();
      const errorMsg = `Browserbase returned non-JSON: ${text}`;
      await supabase.from('plan_logs').insert({
        plan_id,
        msg: `Error: ${errorMsg}`
      });
      
      return new Response(
        JSON.stringify({ error: errorMsg }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    await supabase.from('plan_logs').insert({
      plan_id,
      msg: `✅ Browserbase session created: ${session.id}`
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
      await fetch(`https://api.browserbase.com/v1/sessions/${session.id}`, {
        method: 'DELETE',
        headers: {
          'X-BB-API-Key': browserbaseApiKey,
        }
      });

      await supabase.from('plan_logs').insert({
        plan_id,
        msg: `🛑 Browserbase session closed: ${session.id}`
      });

      return new Response(
        JSON.stringify({ success: true, plan_id, status: result.status }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );

    } catch (error) {
      // Close browser session on error
      await fetch(`https://api.browserbase.com/v1/sessions/${session.id}`, {
        method: 'DELETE',
        headers: {
          'X-BB-API-Key': browserbaseApiKey,
        }
      });

      await supabase.from('plan_logs').insert({
        plan_id,
        msg: `🛑 Browserbase session closed: ${session.id}`
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

    const navigateResponse = await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}/navigate`, {
      method: 'POST',
      headers: {
        'X-BB-API-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: targetUrl })
    });

    if (!navigateResponse.ok) {
      throw new Error('Failed to navigate to target URL');
    }

    // Wait for page load
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Step 2: Find and click preferred slot with retry logic
    await supabase.from('plan_logs').insert({
      plan_id: plan.id,
      msg: `Starting slot selection - preferred: "${plan.preferred}"${plan.alternate ? `, alternate: "${plan.alternate}"` : ''}`
    });

    const slotResult = await findSlotWithRetry(sessionId, apiKey, plan, supabase);
    
    if (!slotResult.success) {
      throw new Error(slotResult.message);
    }

    await supabase.from('plan_logs').insert({
      plan_id: plan.id,
      msg: `Slot selection completed - ${slotResult.message}`
    });

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
    await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}/navigate`, {
      method: 'POST',
      headers: {
        'X-BB-API-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: cartUrl })
    });

    await new Promise(resolve => setTimeout(resolve, 2000));

    // Step 5: Verify item is in cart (use the slot that was successfully added)
    let verificationText = slotResult.slot_used === 'preferred' ? plan.preferred : plan.alternate;
    await supabase.from('plan_logs').insert({
      plan_id: plan.id,
      msg: `Checking if selected item "${verificationText}" is in cart...`
    });

    const itemInCart = await verifyItemInCart(sessionId, apiKey, verificationText);
    
    if (!itemInCart) {
      await supabase.from('plan_logs').insert({
        plan_id: plan.id,
        msg: `Selected item "${verificationText}" not found in cart - may have failed to add`
      });
      throw new Error(`Selected item not in cart: ${verificationText}`);
    }

    await supabase.from('plan_logs').insert({
      plan_id: plan.id,
      msg: `Selected item "${verificationText}" confirmed in cart`
    });

    // Step 6: Proceed to checkout and handle CVV
    await supabase.from('plan_logs').insert({
      plan_id: plan.id,
      msg: 'Proceeding to checkout...'
    });

    const checkoutResult = await handleCheckoutWithCVV(sessionId, apiKey, plan, credentials, supabase);
    
    // Preserve the slot selection status if checkout was successful
    if (checkoutResult.success && checkoutResult.status === 'success') {
      checkoutResult.status = slotResult.status; // 'success' or 'alt_success'
      checkoutResult.slot_used = slotResult.slot_used;
    } else if (checkoutResult.success && checkoutResult.status === 'action_required') {
      // For CVV challenges, keep action_required but add slot info
      checkoutResult.slot_used = slotResult.slot_used;
    }
    
    return checkoutResult;

  } catch (error) {
    return {
      success: false,
      status: 'error',
      message: `Execution failed: ${error.message}`
    };
  }
}

// Helper function to find and click an element with enhanced fuzzy matching
async function findAndClickElement(sessionId: string, apiKey: string, text: string, elementType: string, className?: string): Promise<boolean> {
  try {
    // Get page content
    const contentResponse = await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}/content`, {
      method: 'GET',
      headers: {
        'X-BB-API-Key': apiKey,
      }
    });

    if (!contentResponse.ok) return false;

    const content = await contentResponse.text();
    
    // Enhanced fuzzy matching strategies
    const searchTerms = [
      text, // Exact match
      text.toLowerCase(),
      text.replace(/\s+/g, ''), // Remove spaces
      text.replace(/[^\w\s]/g, ''), // Remove special characters
      ...text.split(/\s+/), // Individual words
      text.substring(0, Math.min(text.length, 10)) // First 10 characters
    ];
    
    // Check if any search term is found in content
    const textFound = searchTerms.some(term => 
      content.toLowerCase().includes(term.toLowerCase())
    );

    if (!textFound) return false;

    // Enhanced selector strategies with fuzzy matching
    const selectors = [
      // Exact text matching
      `*:contains("${text}")`,
      `button:contains("${text}")`,
      `a:contains("${text}")`,
      `div:contains("${text}")`,
      `span:contains("${text}")`,
      
      // Class and ID-based matching
      `[class*="${className || text.toLowerCase().replace(/\s+/g, '')}"]`,
      `[id*="${className || text.toLowerCase().replace(/\s+/g, '')}"]`,
      `[data-testid*="${text.toLowerCase().replace(/\s+/g, '')}"]`,
      
      // Fuzzy text matching for individual words
      ...text.split(/\s+/).map(word => `*:contains("${word}")`),
      
      // Element type with partial text
      `${elementType}:contains("${text}")`,
      `${elementType}[class*="${text.toLowerCase().replace(/\s+/g, '')}"]`,
      
      // Common lesson/class selectors
      `button[class*="lesson"]`,
      `button[class*="class"]`,
      `button[class*="slot"]`,
      `a[class*="lesson"]`,
      `a[class*="class"]`,
      `a[class*="slot"]`,
      
      // Time-based selectors
      `*[class*="time"]`,
      `*[class*="schedule"]`,
      `*[class*="booking"]`
    ];

    for (const selector of selectors) {
      try {
        const clickResponse = await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}/click`, {
          method: 'POST',
          headers: {
            'X-BB-API-Key': apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ selector })
        });

        if (clickResponse.ok) {
          await new Promise(resolve => setTimeout(resolve, 1500)); // Increased delay for reliability
          console.log(`Successfully clicked element using selector: ${selector}`);
          return true;
        }
      } catch (e) {
        // Continue to next selector
      }
    }

    return false;
  } catch (error) {
    console.error('Error in findAndClickElement:', error);
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
        const selectResponse = await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}/select`, {
          method: 'POST',
          headers: {
            'X-BB-API-Key': apiKey,
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
    const contentResponse = await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}/content`, {
      method: 'GET',
      headers: {
        'X-BB-API-Key': apiKey,
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
        status: 'error',
        message: 'No checkout button found'
      };
    }

    // Wait for payment page
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Check if CVV is required
    const cvvRequired = await checkIfCVVRequired(sessionId, apiKey);
    
    // CAPTCHA DETECTION - Do NOT autosolve; SMS + verify link only
    const captchaDetected = await checkIfCaptchaRequired(sessionId, apiKey);
    if (captchaDetected) {
      await supabase.from('plan_logs').insert({
        plan_id: plan.id,
        msg: 'CAPTCHA detected on payment page - POLICY: Do NOT autosolve; SMS + verify link only'
      });
      
      // IMPORTANT: Following our policy of CAPTCHA_AUTOSOLVE_ENABLED = false
      // We DO NOT attempt to solve CAPTCHAs automatically
      // Instead, we create a challenge for manual user verification
      
      // Create CAPTCHA challenge via challenge-create function
      const { data: captchaChallenge, error: captchaError } = await supabase
        .functions
        .invoke('challenge-create', {
          body: { 
            plan_id: plan.id, 
            type: 'captcha' 
          },
          headers: { Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` }
        });

      if (captchaError || !captchaChallenge?.success) {
        await supabase.from('plan_logs').insert({
          plan_id: plan.id,
          msg: 'Failed to create CAPTCHA challenge'
        });
      } else {
        const captchaToken = captchaChallenge.token;
        
        // Send SMS notification if phone number is available (per SMS_IMMEDIATE_ON_ACTION_REQUIRED policy)
        if (plan.phone && SMS_IMMEDIATE_ON_ACTION_REQUIRED) {
          const { error: smsError } = await supabase
            .functions
            .invoke('notify', {
              body: { 
                to: plan.phone, 
                token: captchaToken,
                org: plan.org 
              }
            });

          if (smsError) {
            await supabase.from('plan_logs').insert({
              plan_id: plan.id,
              msg: `CAPTCHA challenge created but SMS notification failed: ${smsError.message}`
            });
          } else {
            await supabase.from('plan_logs').insert({
              plan_id: plan.id,
              msg: `CAPTCHA challenge created - SMS sent to ${plan.phone} with verification token: ${captchaToken}`
            });
          }
        } else {
          await supabase.from('plan_logs').insert({
            plan_id: plan.id,
            msg: `CAPTCHA challenge created with token: ${captchaToken} (no phone number for SMS)`
          });
        }
      }

      return {
        success: true,
        status: 'action_required',
        message: 'CAPTCHA verification required - user action needed',
        challenge_token: captchaChallenge?.token
      };
    }
    
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
        // CVV not available - create challenge and send SMS
        await supabase.from('plan_logs').insert({
          plan_id: plan.id,
          msg: 'CVV required but not available - creating challenge'
        });

        // Create CVV challenge via challenge-create function
        const { data: challengeResponse, error: challengeError } = await supabase
          .functions
          .invoke('challenge-create', {
            body: { 
              plan_id: plan.id, 
              type: 'cvv' 
            },
            headers: { Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` }
          });

        if (challengeError || !challengeResponse?.success) {
          await supabase.from('plan_logs').insert({
            plan_id: plan.id,
            msg: 'Failed to create CVV challenge'
          });
          
          return {
            success: false,
            status: 'error',
            message: 'Failed to create CVV challenge'
          };
        }

        const token = challengeResponse.token;
        
        // Send SMS notification if phone number is available
        if (plan.phone) {
          const { error: smsError } = await supabase
            .functions
            .invoke('notify', {
              body: { 
                to: plan.phone, 
                token: token,
                org: plan.org 
              }
            });

          if (smsError) {
            await supabase.from('plan_logs').insert({
              plan_id: plan.id,
              msg: `SMS notification failed: ${smsError.message}`
            });
          } else {
            await supabase.from('plan_logs').insert({
              plan_id: plan.id,
              msg: `SMS sent to ${plan.phone} with verification token: ${token}`
            });
          }
        } else {
          await supabase.from('plan_logs').insert({
            plan_id: plan.id,
            msg: `CVV challenge created with token: ${token} (no phone number for SMS)`
          });
        }

        return {
          success: true,
          status: 'action_required',
          message: 'CVV required - user action needed',
          challenge_token: token
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
      status: 'error',
      message: 'Checkout process failed'
    };

  } catch (error) {
    return {
      success: false,
      status: 'error',
      message: `Checkout error: ${error.message}`
    };
  }
}

// Helper function to check if CAPTCHA is required
async function checkIfCaptchaRequired(sessionId: string, apiKey: string): Promise<boolean> {
  try {
    const contentResponse = await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}/content`, {
      method: 'GET',
      headers: {
        'X-BB-API-Key': apiKey,
      }
    });

    if (!contentResponse.ok) return false;

    const content = await contentResponse.text();
    
    // CAPTCHA DETECTION POLICY: Do NOT autosolve; SMS + verify link only
    // Common CAPTCHA indicators - we detect but DO NOT solve automatically
    const captchaKeywords = [
      'captcha', 'recaptcha', 'hcaptcha', 'cloudflare', 'turnstile',
      'verify you are human', 'prove you are human', 'security check',
      'challenge', 'verification', 'robot', 'automated'
    ];
    
    const captchaFound = captchaKeywords.some(keyword => 
      content.toLowerCase().includes(keyword)
    );
    
    // Also check for common CAPTCHA iframe or div patterns
    const captchaPatterns = [
      'g-recaptcha', 'h-captcha', 'cf-turnstile', 
      'captcha-container', 'recaptcha-container'
    ];
    
    const captchaPatternFound = captchaPatterns.some(pattern =>
      content.toLowerCase().includes(pattern)
    );
    
    return captchaFound || captchaPatternFound;
  } catch (error) {
    return false;
  }
}

// Helper function to check if CVV is required
async function checkIfCVVRequired(sessionId: string, apiKey: string): Promise<boolean> {
  try {
    const contentResponse = await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}/content`, {
      method: 'GET',
      headers: {
        'X-BB-API-Key': apiKey,
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
        const typeResponse = await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}/type`, {
          method: 'POST',
          headers: {
            'X-BB-API-Key': apiKey,
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
    const contentResponse = await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}/content`, {
      method: 'GET',
      headers: {
        'X-BB-API-Key': apiKey,
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

// Helper function to find slot with retry logic
async function findSlotWithRetry(sessionId: string, apiKey: string, plan: any, supabase: any) {
  const PREFERRED_RETRY_DURATION = 75000; // 75 seconds (60-90s range)
  const ALTERNATE_RETRY_DURATION = 25000; // 25 seconds (20-30s range)
  const RELOAD_INTERVAL = 4000; // 4 seconds (3-5s range)
  
  // Phase 1: Try preferred slot with retries
  await supabase.from('plan_logs').insert({
    plan_id: plan.id,
    msg: `Phase 1: Attempting preferred slot "${plan.preferred}" with ${PREFERRED_RETRY_DURATION/1000}s retry window`
  });
  
  const preferredStartTime = Date.now();
  let preferredAttempts = 0;
  
  while (Date.now() - preferredStartTime < PREFERRED_RETRY_DURATION) {
    preferredAttempts++;
    const preferredSearchText = plan.preferred_class_name 
      ? `${plan.preferred_class_name} ${plan.preferred}` 
      : plan.preferred;
    
    await supabase.from('plan_logs').insert({
      plan_id: plan.id,
      msg: `Preferred slot attempt ${preferredAttempts} - searching for "${preferredSearchText}"${plan.preferred_class_name ? ` (class: ${plan.preferred_class_name})` : ''}`
    });
    
    const preferredFound = await findAndClickElement(sessionId, apiKey, preferredSearchText, 'preferred slot', plan.preferred_class_name);
    
    if (preferredFound) {
      await supabase.from('plan_logs').insert({
        plan_id: plan.id,
        msg: `✓ Preferred slot "${plan.preferred}" found and clicked on attempt ${preferredAttempts}`
      });
      
      // Verify the slot was actually added by checking cart or confirmation
      await new Promise(resolve => setTimeout(resolve, 2000));
      const addedSuccessfully = await verifySlotAdded(sessionId, apiKey, plan.preferred);
      
      if (addedSuccessfully) {
        return {
          success: true,
          status: 'success',
          message: `Preferred slot "${plan.preferred}" successfully added`,
          slot_used: 'preferred'
        };
      } else {
        await supabase.from('plan_logs').insert({
          plan_id: plan.id,
          msg: `Preferred slot clicked but not confirmed in system - continuing retries`
        });
      }
    }
    
    // Reload page and wait before next attempt
    if (Date.now() - preferredStartTime < PREFERRED_RETRY_DURATION - RELOAD_INTERVAL) {
      await supabase.from('plan_logs').insert({
        plan_id: plan.id,
        msg: `Reloading page for next attempt in ${RELOAD_INTERVAL/1000}s...`
      });
      
      // Navigate back to refresh the page
      let targetUrl = plan.discovered_url || `${plan.base_url}/dashboard`;
      await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}/navigate`, {
        method: 'POST',
        headers: {
          'X-BB-API-Key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: targetUrl })
      });
      
      await new Promise(resolve => setTimeout(resolve, RELOAD_INTERVAL));
    }
  }
  
  await supabase.from('plan_logs').insert({
    plan_id: plan.id,
    msg: `Phase 1 complete: Preferred slot "${plan.preferred}" not found after ${preferredAttempts} attempts over ${PREFERRED_RETRY_DURATION/1000}s`
  });
  
  // Phase 2: Try alternate slot if available
  if (!plan.alternate) {
    return {
      success: false,
      status: 'error',
      message: `Preferred slot "${plan.preferred}" not found and no alternate specified`,
      slot_used: 'none'
    };
  }
  
  await supabase.from('plan_logs').insert({
    plan_id: plan.id,
    msg: `Phase 2: Attempting alternate slot "${plan.alternate}" with ${ALTERNATE_RETRY_DURATION/1000}s retry window`
  });
  
  const alternateStartTime = Date.now();
  let alternateAttempts = 0;
  
  while (Date.now() - alternateStartTime < ALTERNATE_RETRY_DURATION) {
    alternateAttempts++;
    const alternateSearchText = plan.alternate_class_name 
      ? `${plan.alternate_class_name} ${plan.alternate}` 
      : plan.alternate;
    
    await supabase.from('plan_logs').insert({
      plan_id: plan.id,
      msg: `Alternate slot attempt ${alternateAttempts} - searching for "${alternateSearchText}"${plan.alternate_class_name ? ` (class: ${plan.alternate_class_name})` : ''}`
    });
    
    const alternateFound = await findAndClickElement(sessionId, apiKey, alternateSearchText, 'alternate slot', plan.alternate_class_name);
    
    if (alternateFound) {
      await supabase.from('plan_logs').insert({
        plan_id: plan.id,
        msg: `✓ Alternate slot "${plan.alternate}" found and clicked on attempt ${alternateAttempts}`
      });
      
      // Verify the slot was actually added
      await new Promise(resolve => setTimeout(resolve, 2000));
      const addedSuccessfully = await verifySlotAdded(sessionId, apiKey, plan.alternate);
      
      if (addedSuccessfully) {
        return {
          success: true,
          status: 'alt_success',
          message: `Alternate slot "${plan.alternate}" successfully added (preferred "${plan.preferred}" was not available)`,
          slot_used: 'alternate'
        };
      } else {
        await supabase.from('plan_logs').insert({
          plan_id: plan.id,
          msg: `Alternate slot clicked but not confirmed in system - continuing retries`
        });
      }
    }
    
    // Reload page and wait before next attempt
    if (Date.now() - alternateStartTime < ALTERNATE_RETRY_DURATION - RELOAD_INTERVAL) {
      await supabase.from('plan_logs').insert({
        plan_id: plan.id,
        msg: `Reloading page for alternate retry in ${RELOAD_INTERVAL/1000}s...`
      });
      
      let targetUrl = plan.discovered_url || `${plan.base_url}/dashboard`;
      await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}/navigate`, {
        method: 'POST',
        headers: {
          'X-BB-API-Key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: targetUrl })
      });
      
      await new Promise(resolve => setTimeout(resolve, RELOAD_INTERVAL));
    }
  }
  
  await supabase.from('plan_logs').insert({
    plan_id: plan.id,
    msg: `Phase 2 complete: Alternate slot "${plan.alternate}" not found after ${alternateAttempts} attempts over ${ALTERNATE_RETRY_DURATION/1000}s`
  });
  
  return {
    success: false,
    status: 'error',
    message: `Neither preferred slot "${plan.preferred}" nor alternate slot "${plan.alternate}" could be added after extensive retries`,
    slot_used: 'none'
  };
}

// Helper function to verify slot was actually added
async function verifySlotAdded(sessionId: string, apiKey: string, slotText: string): Promise<boolean> {
  try {
    // Check page content for confirmation indicators
    const contentResponse = await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}/content`, {
      method: 'GET',
      headers: {
        'X-BB-API-Key': apiKey,
      }
    });

    if (!contentResponse.ok) return false;

    const content = await contentResponse.text();
    
    // Look for confirmation indicators
    const confirmationKeywords = [
      'added to cart', 'in cart', 'registered', 'enrolled', 
      'selected', 'confirmed', slotText.toLowerCase()
    ];
    
    return confirmationKeywords.some(keyword => 
      content.toLowerCase().includes(keyword)
    );
  } catch (error) {
    return false;
  }
}