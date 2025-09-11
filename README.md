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

## How can I deploy this project?

Simply open [Lovable](https://lovable.dev/projects/659643f5-6853-4cee-9629-8b9d4d6c7eb3) and click on Share -> Publish.

## Can I connect a custom domain to my Lovable project?

Yes, you can!

To connect a domain, navigate to Project > Settings > Domains and click Connect Domain.

Read more here: [Setting up a custom domain](https://docs.lovable.dev/tips-tricks/custom-domain#step-by-step-guide)
