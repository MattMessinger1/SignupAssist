-- Correct the plan's open time to 8:10 PM Central Daylight Time (1:10 AM UTC next day)
UPDATE plans 
SET open_time = '2025-09-11 01:10:00+00',
    status = 'scheduled'
WHERE id = '69ec76a5-4468-419d-b9d3-f82c1d5a3cb4';