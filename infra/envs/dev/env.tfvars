# Non-secret settings for dev. Add the CloudFront origin in Phase 7.
app_origins = ["http://localhost:5173"]

# Google OAuth client "photo-app-dev (Cognito)" (4.3). The secret comes from TF_VAR_google_client_secret.
google_client_id = "1093239771558-h98qa1lulf9o4jqs767g231ohphbsia5.apps.googleusercontent.com"
