-- Reset the failed plan back to scheduled status so it can run again
UPDATE plans 
SET status = 'scheduled' 
WHERE id = '69ec76a5-4468-419d-b9d3-f82c1d5a3cb4';