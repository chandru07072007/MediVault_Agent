import boto3
from dotenv import load_dotenv
import os

# Load AWS credentials from .env
load_dotenv()

s3 = boto3.client(
    's3',
    aws_access_key_id=os.getenv('AWS_ACCESS_KEY_ID'),
    aws_secret_access_key=os.getenv('AWS_SECRET_ACCESS_KEY'),
    region_name=os.getenv('AWS_REGION')
)

bucket_name = os.getenv('S3_BUCKET_NAME')

# The CORS configuration allowing the frontend to upload directly and read ETags
cors_configuration = {
    'CORSRules': [{
        'AllowedHeaders': ['*'],
        'AllowedMethods': ['PUT', 'POST', 'GET', 'DELETE', 'HEAD'],
        'AllowedOrigins': ['http://localhost:5173', 'http://localhost:3000'],
        'ExposeHeaders': ['ETag']
    }]
}

try:
    s3.put_bucket_cors(
        Bucket=bucket_name,
        CORSConfiguration=cors_configuration
    )
    print(f"✅ Successfully configured CORS for bucket: {bucket_name}")
except Exception as e:
    print(f"❌ Failed to configure CORS: {e}")
