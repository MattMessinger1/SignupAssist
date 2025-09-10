-- Update the plan to run tonight at 8:20 PM Central (1:20 AM UTC on Sept 10)
UPDATE plans 
SET open_time = '2025-09-10 01:20:00+00',
    status = 'scheduled'
WHERE id = '69ec76a5-4468-419d-b9d3-f82c1d5a3cb4';