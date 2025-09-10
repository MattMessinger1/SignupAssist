-- Update the plan's open time to 8:03 PM Central (1:03 AM UTC next day)
UPDATE plans 
SET open_time = '2025-09-11 01:03:00+00',
    status = 'scheduled'
WHERE id = '69ec76a5-4468-419d-b9d3-f82c1d5a3cb4';