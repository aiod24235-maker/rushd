FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install
COPY server.js app.js index.html style.css roshd-logo* ./
RUN mkdir -p public && cp index.html style.css roshd-logo* public/ 2>/dev/null || :
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
