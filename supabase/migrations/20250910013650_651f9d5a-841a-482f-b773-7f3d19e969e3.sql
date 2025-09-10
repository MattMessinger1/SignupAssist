-- Update the plan to run at 8:42 PM Central (1:42 AM UTC)
UPDATE plans 
SET open_time = '2025-09-10 01:42:00+00',
    status = 'scheduled'
WHERE id = '69ec76a5-4468-419d-b9d3-f82c1d5a3cb4';