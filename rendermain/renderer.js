/*

    Copyright (C) AlephWeb developers -- github.com/Pfhreak/AlephWeb
    Portions of this code are based on the code:
	Copyright (C) 1991-2001 and beyond by Bungie Studios, Inc.
	and the "Aleph One" developers.
 
	This program is free software; you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation; either version 3 of the License, or
	(at your option) any later version.

	This program is distributed in the hope that it will be useful,
	but WITHOUT ANY WARRANTY; without even the implied warranty of
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
	GNU General Public License for more details.

	This license is contained in the file "COPYING",
	which is included with this source code; it is available online at
	http://www.gnu.org/licenses/gpl.html

*/

/*
 
 render.js - Renders the current game state. Should not alter game state,
        if it does, that's an issue that needs to be logged. Handles
        the roles of Rasterizer and render.cpp since we only need to
        support one platform (webgl) and not 7 hojillion
 
*/

a1.segment(
    'rendermain.renderer',
    'rendermain.surfacemanager',
    'renderother.overheadmap'
).defines(function(){
    // TODO: Move debug constants out of this file
    // The number of polygons to display in 'polymode'
    window.polys = 3;
        
    a1.Renderer = a1.Class.extend({
        // TODO: These shaders should probably be moved out to separate files
        // so we don't need to mess with multiline strings
        vertShaderStr: "precision mediump float;        \n\
            attribute vec3 aVertexPosition;             \n\
            attribute vec3 aTextureCoord;               \n\
            uniform mat4 uMVMatrix;                     \n\
            uniform mat4 uPMatrix;                      \n\
                                                        \n\
            varying vec3 vTextureCoord;                 \n\
            varying float vIntensity;                   \n\
            const int NUM_SURFLIGHTS={0};               \n\
            uniform float uSurfLights[NUM_SURFLIGHTS];  \n\
                                                        \n\
            void main(void) {                           \n\
                gl_Position = uPMatrix * uMVMatrix * vec4(aVertexPosition, 1.0);\n\
                vTextureCoord = aTextureCoord;          \n\
                                                        \n\
                vIntensity = uSurfLights[int(aTextureCoord.p + 0.1)];\n\
            }",
        
        fragShaderStr: "precision mediump float;\n\
                                                \n\
            varying vec3 vTextureCoord;         \n\
            varying float vIntensity;\
            uniform sampler2D uSampler;         \n\
                                                \n\
            vec4 col;                           \n\
            float alph;                         \n\
            int src;                            \n\
            void main(void) {			        \n\
                col = texture2D(uSampler, vec2(vTextureCoord.s, vTextureCoord.t));\n\
                alph = col.a;                   \n\
                col = vIntensity * col;         \n\
                col.a = alph;                   \n\
                gl_FragColor = col;             \n\
                if(gl_FragColor.a <.5)          \n\
                    discard;                    \n\
            }",
        
        visPolys:[],
        prevPolyCount: -1,
        
        // If we are rendering in polymode, we will use this index buffer to control
        // which polygons are visible
        indexBuffer:null,
        
        camPos: [0, 0, 0], 

        pMatrix: null, // projection matrix
        mvMatrix: null, // model-view matrix of the player's position/rotation
        overheadMap: null, // the overhead map renderer
        overheadMapData: null, 
        
        init:function(){
            this.overheadMap = new a1.OverheadMap();
            this.overheadMapData = new a1.OverheadMapData();
        },
        
        initBuffers: function(){
            this.indexBuffer = a1.gl.createBuffer();
	    
            // update the vert shader with the number of surface lights
            var shaderStr = this.vertShaderStr.replace("{0}", a1.mapData.getChunkEntryCount("LITE"));
            
            // Create our shaders and program
            var fragShader = a1.createShader(a1.gl.FRAGMENT_SHADER, this.fragShaderStr);
            var vertShader = a1.createShader(a1.gl.VERTEX_SHADER, shaderStr);
            this.program = a1.createProgram([fragShader, vertShader]);
            
            // create our matrices
            this.pMatrix = mat4.create();
            this.mvMatrix = mat4.create();
            
            // store our uniform locations
            this.program.pMatrixUniform = a1.gl.getUniformLocation(this.program, "uPMatrix");
            this.program.mvMatrixUniform = a1.gl.getUniformLocation(this.program, "uMVMatrix");
            this.program.samplerUniform = a1.gl.getUniformLocation(this.program, "uSampler");
            this.program.surfLightUniform = a1.gl.getUniformLocation(this.program, "uSurfLights");
            
            // Use the program we just built so we can get other addresses from it
            a1.gl.useProgram(this.program);
            
            // Store and enable our texture and vertex position attributes
            this.program.vertexPositionAttribute = a1.gl.getAttribLocation(this.program, "aVertexPosition");
            a1.gl.enableVertexAttribArray(this.program.vertexPositionAttribute);
            
            this.program.texCoordAttribute = a1.gl.getAttribLocation(this.program, "aTextureCoord");
            a1.gl.enableVertexAttribArray(this.program.texCoordAttribute);
            
            
            a1.gl.uniform1i(this.program.samplerUniform, 0);
            
            a1.gl.viewport(0,0,a1.gl.viewportWidth, a1.gl.viewportHeight);
            
            mat4.perspective(50, a1.gl.viewportWidth/ a1.gl.viewportHeight, 10, 100000.0, this.pMatrix);
            a1.gl.uniformMatrix4fv(this.program.pMatrixUniform, false, this.pMatrix);
            
            a1.gl.activeTexture(a1.gl.TEXTURE0);
            
            // TODO: The surface windings in surfacemanager.js could be rewritten in a way that allows us to enable
            // backface culling. But I need to do more research on how marathon renders transparent walls before I'd
            // be comfortable doing that
            a1.gl.disable(a1.gl.CULL_FACE); 
            //a1.gl.blendFunc(a1.gl.SRC_ALPHA, a1.gl.ONE);
        },
        
        // Renders the player's view
        // Simple! Right?
        // ... right? guys? Where'd everyone go?
        render:function(viewData){
            var i,j;
            var poly,endPt;
            
            if (this.indexBuffer == null){
                this.initBuffers();
            }
            
            // If you are bored, turn this off for bizarro Marathon!
            a1.gl.enable(a1.gl.DEPTH_TEST);
            
            // Clear the screen. I like red, cause it makes it obvious when I have
            // gaps in the level
            a1.gl.clearColor(0.6,0.0,0.0,1.0);
            a1.gl.clear(a1.gl.COLOR_BUFFER_BIT | a1.gl.DEPTH_BUFFER_BIT);

            // Establish our view
            mat4.identity(this.mvMatrix);
            
            this.camPos[0] = a1.P.position[0]*-1;
            this.camPos[1] = a1.P.position[1]*-1;
            this.camPos[2] = a1.P.position[2]*-1;
	                
            mat4.rotate(this.mvMatrix, a1.P.rotation, [0,1,0]);
            mat4.translate(this.mvMatrix, this.camPos);
            a1.gl.uniformMatrix4fv(this.program.mvMatrixUniform, false, this.mvMatrix);
            
            // Reset Overhead Map
            // NOTE: This doesn't do anything yet, but it will become more important later
            a1.mapData.resetOverheadMap();
    
            // Render terminal if active
            if (false)
            {
                // TODO
                // Render awesome terminal text
                // Maybe by displaying a <div> element above the canvas? No need
                // to render everything in WebGL if it makes more sense to render in
                // HTML
            }
            else
            {
                // Determine the visible polys
                // TODO: pull this out and create a subsetting function
                // Ideally determining the visible polys would be a function you could
                // redefine at runtime, so you could create your own debug views directly
                // in the console
                this.visPolys.length = 0;
                
                if (a1.P.polymode){ // Polymode, grab the first window.polys polygons for rendering
                    for(i = 0; i < window.polys; i++){
                        this.visPolys.push(i);
                    }
                } else {
                    // RENDER ALL THE THINGS! (All polys rendered)
                    for(i = 0; i < a1.mapData.getChunkEntryCount("POLY"); i++){
                        this.visPolys.push(i);                        
                    }
                }
                
                // Render the map if active
                if (a1.P.overheadMap){
                    this.overheadMap.render(this.overheadMapData);
                } else {
                    // Render the world if the map isn't active
                    a1.gl.useProgram(this.program);
                    
                    // Update the lighting information
                    a1.gl.uniform1fv(this.program.surfLightUniform, a1.LM.getIntensityArray());

                    // Clear the surface manager's cache
                    if (this.prevPolyCount != this.visPolys.length){
                        a1.SM.clearCache();
                    
                        // Register all the polygons we plan to draw
                        for(i=0; i < this.visPolys.length;i++){
                            a1.SM.registerPoly(this.visPolys[i]);
                        }
                    }
                    
                    this.prevPolyCount = this.visPolys.length;
                    
                    // Bind to the index buffer and texture0 for the frame
                    a1.gl.bindBuffer(a1.gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
                    
                    var posBuffer, texBuffer;
                    // For each material in the rendercache
                    // fire off a call to draw elements
                    for (var matID in a1.SM.renderCache){
                        // Fetch references to the vertex and texture buffers for this material
                        posBuffer = a1.SM.surfaceBuffers[matID].posBuffer;
                        texBuffer = a1.SM.surfaceBuffers[matID].texBuffer;
                        
                        // Send the data to the video card
                        a1.gl.bindBuffer(a1.gl.ARRAY_BUFFER, posBuffer);
                        a1.gl.vertexAttribPointer(this.program.vertexPositionAttribute, posBuffer.itemSize, a1.gl.FLOAT, false, 0, 0);
                        a1.gl.bindBuffer(a1.gl.ARRAY_BUFFER, texBuffer);
                        a1.gl.vertexAttribPointer(this.program.texCoordAttribute, texBuffer.itemSize, a1.gl.FLOAT, false, 0, 0);
                        
                        a1.gl.bindTexture(a1.gl.TEXTURE_2D, a1.TM.loadTexture(matID));
                        
                        // Update the index buffer
                        if (a1.P.polymode){
                        
                            a1.gl.bindBuffer(a1.gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
                            a1.gl.bufferData(a1.gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(a1.SM.renderCache[matID]), a1.gl.STATIC_DRAW);
                            this.indexBuffer.itemSize = 1;
                            this.indexBuffer.numItems = a1.SM.renderCache[matID].length;
                            a1.gl.drawElements(a1.gl.TRIANGLES, this.indexBuffer.numItems, a1.gl.UNSIGNED_SHORT, 0);  
                        }
                        else{
                            a1.gl.bindBuffer(a1.gl.ELEMENT_ARRAY_BUFFER, a1.SM.surfaceBuffers[matID].idxBuffer);
                            
                            a1.gl.drawElements(a1.gl.TRIANGLES, a1.SM.surfaceBuffers[matID].idxBuffer.numItems, a1.gl.UNSIGNED_SHORT, 0);
                        }
                    }

                    // Cleanup
                    a1.gl.bindBuffer(a1.gl.ARRAY_BUFFER, null);
                    a1.gl.bindBuffer(a1.gl.ELEMENT_ARRAY_BUFFER, null);
                    // Determine objects in the view
                }
            }
        }
    });
});