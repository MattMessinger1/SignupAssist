# Welcome to your Lovable project

## Project info

**URL**: https://lovable.dev/projects/659643f5-6853-4cee-9629-8b9d4d6c7eb3

## How can I edit this code?

There are several ways of editing your application.

**Use Lovable**

Simply visit the [Lovable Project](https://lovable.dev/projects/659643f5-6853-4cee-9629-8b9d4d6c7eb3) and start prompting.

Changes made via Lovable will be committed automatically to this repo.

**Use your preferred IDE**

If you want to work locally using your own IDE, you can clone this repo and push changes. Pushed changes will also be reflected in Lovable.

The only requirement is having Node.js & npm installed - [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating)

Follow these steps:

```sh
# Step 1: Clone the repository using the project's Git URL.
git clone <YOUR_GIT_URL>

# Step 2: Navigate to the project directory.
cd <YOUR_PROJECT_NAME>

# Step 3: Install the necessary dependencies.
npm i

# Step 4: Start the development server with auto-reloading and an instant preview.
npm run dev
```

**Edit a file directly in GitHub**

- Navigate to the desired file(s).
- Click the "Edit" button (pencil icon) at the top right of the file view.
- Make your changes and commit the changes.

**Use GitHub Codespaces**

- Navigate to the main page of your repository.
- Click on the "Code" button (green button) near the top right.
- Select the "Codespaces" tab.
- Click on "New codespace" to launch a new Codespace environment.
- Edit files directly within the Codespace and commit and push your changes once you're done.

## What technologies are used for this project?

This project is built with:

- Vite
- TypeScript
- React
- shadcn-ui
- Tailwind CSS

## Debug Configuration

For debugging the Supabase edge functions (especially `run-plan`), you can enable verbose logging by setting the `DEBUG_VERBOSE` environment variable to `1` in your Supabase function secrets. This will enable detailed diagnostic logs without requiring code changes.

To set this up:
1. Go to your [Supabase Dashboard > Functions > Secrets](https://supabase.com/dashboard/project/pyoszlfqqvljwocrrafl/settings/functions)
2. Add a new secret: `DEBUG_VERBOSE=1`
3. Redeploy your functions or wait for the next execution

This helps with production debugging by providing more detailed logs for troubleshooting.

## Deploying Edge Functions

To deploy Supabase Edge Functions to your project (pyoszlfqqvljwocrrafl), follow these steps:

1. **Prerequisites**: Ensure you have the [Supabase CLI](https://supabase.com/docs/reference/cli) installed and are logged in:
   ```sh
   supabase login
   ```

2. **Deploy all functions**: Run the deployment script to deploy all edge functions at once:
   ```sh
   scripts/deploy_edge_functions.sh
   ```
   This script will automatically deploy all functions in the `supabase/functions/` directory (excluding `_shared`). Already-deployed functions will be safely redeployed with the latest changes.

3. **Deploy a single function**: If you only want to deploy a specific function:
   ```sh
   supabase functions deploy <function-name>
   ```
   For example: `supabase functions deploy cred-store`

The deployment script skips the `_shared` folder and only deploys directories that contain an `index.*` file.

## Credential Encryption Key (CRED_ENC_KEY)

### What is CRED_ENC_KEY?

`CRED_ENC_KEY` is a 32-byte secret key used to encrypt and decrypt sensitive user credentials (email addresses, passwords, and CVV codes) stored in the database. This key ensures that even if the database is compromised, user credentials remain protected through AES-GCM encryption.

**Critical Requirement:** The `CRED_ENC_KEY` must be **identical** across all environments:
- Supabase Edge Functions
- Railway worker service  
- Local development environment

### Generating a New Key

To generate a new 32-byte base64-encoded encryption key:

```bash
openssl rand -base64 32
```

Example output: `q4mBOy4dM5LfgUv3lf6GRgxCfv8HZoM8I8ACDcvaF1I=`

### Updating the Key Across Environments

When updating `CRED_ENC_KEY`, you must update it in **all three locations**:

#### 1. Railway Worker Service
1. Go to [Railway Dashboard](https://railway.app) → Your Project → Variables
2. Add/update: `CRED_ENC_KEY=your_new_key_here`
3. Redeploy the service

#### 2. Supabase Edge Functions
1. Go to [Supabase Dashboard](https://supabase.com/dashboard/project/pyoszlfqqvljwocrrafl/settings/functions) → Project Settings → Functions → Secrets
2. Add/update: `CRED_ENC_KEY=your_new_key_here`
3. Edge functions will use the new key on next execution

#### 3. Local Development Environment
1. Create/update `.env.local` file in project root:
   ```bash
   CRED_ENC_KEY=your_new_key_here
   ```
2. Restart your local development server (`npm run dev`)

### ⚠️ Critical Warning

**Whenever `CRED_ENC_KEY` changes, previously saved credentials cannot be decrypted.**

All users must:
1. Navigate to the Credentials page in the SignupAssist UI
2. Delete existing credentials (they will show decryption errors)
3. Re-save their credentials with the same information
4. Test functionality by creating a new plan

### Troubleshooting

If you see **"Failed to decrypt credentials"** errors in `plan_logs`:
- Check that `CRED_ENC_KEY` is set identically in all three environments
- Verify the key is exactly 32 bytes when base64-decoded
- Confirm users have re-saved their credentials after any key changes

**Current synchronized key:** `q4mBOy4dM5LfgUv3lf6GRgxCfv8HZoM8I8ACDcvaF1I=`

## How can I deploy this project?

Simply open [Lovable](https://lovable.dev/projects/659643f5-6853-4cee-9629-8b9d4d6c7eb3) and click on Share -> Publish.

## Can I connect a custom domain to my Lovable project?

Yes, you can!

To connect a domain, navigate to Project > Settings > Domains and click Connect Domain.

Read more here: [Setting up a custom domain](https://docs.lovable.dev/tips-tricks/custom-domain#step-by-step-guide)
