# Use an official Node.js runtime as the base image
FROM node:22-alpine

# Create and switch to the app directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (if present)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy all remaining files to the container
COPY . .

# Use the same port that your server listens on inside your code
ENV PORT=4000
EXPOSE 4000

# Set NODE_ENV to 'production'
ENV NODE_ENV=production

# Start the application
CMD ["npm", "start"]