# Ravana

The "Hardware Gap" often prevents students and independent creators from accessing high-fidelity 3D visuals due to the extreme computational demands of professional rendering. While traditional distributed systems exist, they typically require local software installations and complex network configurations. Ravana is a zero-install, browser-based compute farm. It utilizes a master-worker architecture to parse GLTF-exported Blender scenes, distribute intensive tile-based rendering tasks to mobile devices via WebGL, and stitch the results into a final high-resolution output. This approach demonstrates that a powerful rendering cluster can be formed instantly using the collective power of the devices already in our pockets.

Ravana was made as part of CUSAT's Make-A-Ton 8.0 Hackathon. 

## Setup

Clone the project. Initialise submodules and pull the server code.
```bash
git clone https://github.com/simonknowsstuff/ravana.git
cd ravana
git submodule init
git submodule update --remote
```

Install the dependencies for the client and the server
```
cd client; npm install
cd ../server; npm install
```

Run the server using `npm start`, and connect to the server by ensuring an .env file with the url to the server is specified (`VITE_WS_SERVER_URL`, refer .env.example) Then run the client using `cd ../client; npm run dev`

## Usage
Upload any GLB file to the project. Connect to the QR Code using any other device or with another tab and the rendering should begin.

## Notes
- The BVH lighting code has a long way to go before it's actually usable in a real-life scenario
- threejs' path tracer library is used under the experimental branch, which can be tried out for better results
- We still have to figure out some lighting issues with the models being uploaded straight from Blender

## Credits
- Seraphin J Raphy
- Johan Abraham