require('dotenv').config(); // Load environment variables from .env file

module.exports = {
    BASE_URL: process.env.BASE_URL,
    PROFILE_BASE_URL: process.env.PROFILE_BASE_URL,
    MEDIA_ROOT_PATH: process.env.MEDIA_ROOT_PATH,
    MEDIA_BASE_URL: process.env.MEDIA_BASE_URL,

    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_USERNAME: process.env.DATABASE_USERNAME,
    DATABASE_PASSWORD: process.env.DATABASE_PASSWORD,
    DATABASE_NAME: process.env.DATABASE_NAME,


    S3_BUCKET_REGION: process.env.S3_BUCKET_REGION,
    S3_BUCKET_NAME: process.env.S3_BUCKET_NAME,
    S3_BUCKET_ACCESS_KEY: process.env.S3_BUCKET_ACCESS_KEY,
    S3_BUCKET_SECRET_kEY: process.env.S3_BUCKET_SECRET_KEY,
};
