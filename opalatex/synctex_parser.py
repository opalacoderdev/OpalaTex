import gzip
import os
import math
import sys

class SynctexParser:
    def __init__(self, synctex_path):
        self.synctex_path = synctex_path
        self.inputs = {}  # tag -> filename
        self.nodes = []   # list of dicts: {'tag': tag, 'line': line, 'page': page, 'x': x, 'y': y, 'type': node_type}
        self._parse()

    def _parse(self):
        if not os.path.exists(self.synctex_path):
            return
            
        try:
            with gzip.open(self.synctex_path, 'rt', encoding='utf-8') as f:
                content = f.read()
        except Exception:
            return

        lines = content.split('\n')
        current_page = 1
        
        for line in lines:
            if not line:
                continue
                
            if line.startswith('Input:'):
                parts = line.split(':', 2)
                if len(parts) == 3:
                    tag = parts[1]
                    filename = parts[2].strip()
                    self.inputs[tag] = filename
            elif line.startswith('{'):
                # Page start
                try:
                    current_page = int(line[1:].strip())
                except:
                    pass
            elif line[0] in ('h', 'v', 'x', 'g', 'k', 'f', 'r', 'm', '(', '['):
                    # node: type tag,line:x,y:W,H,D
                    parts = line[1:].split(':')
                    if len(parts) >= 2:
                        tag_line = parts[0].split(',')
                        if len(tag_line) == 2:
                            tag = tag_line[0] # keep as string to match parser.inputs
                            source_line = int(tag_line[1])
                            coords = parts[1].split(',')
                            if len(coords) >= 2:
                                try:
                                    x = int(coords[0]) / 65536.0
                                    y = int(coords[1]) / 65536.0
                                    w = 0
                                    h = 0
                                    if len(parts) >= 3:
                                        dims = parts[2].split(',')
                                        if len(dims) >= 2:
                                            w = int(dims[0]) / 65536.0
                                            h = int(dims[1]) / 65536.0
                                    
                                    self.nodes.append({
                                        'tag': tag,
                                        'line': source_line,
                                        'page': current_page,
                                        'x': x,
                                        'y': y,
                                        'w': w,
                                        'h': h,
                                        'type': line[0]
                                    })
                                except:
                                    pass

def find_pdf_position(synctex_path, target_file, target_line):
    """Finds the first node matching the target file and line."""
    parser = SynctexParser(synctex_path)
    
    target_basename = os.path.basename(target_file)
    target_tag = None
    for tag, filename in parser.inputs.items():
        if os.path.basename(filename) == target_basename:
            target_tag = tag
            break
            
    if not target_tag:
        return None
        
    best_nodes = []
    min_dist = float('inf')
    best_line = -1
    
    for node in parser.nodes:
        if node['tag'] == target_tag:
            dist = abs(node['line'] - target_line)
            if dist < min_dist:
                min_dist = dist
                best_line = node['line']
                best_nodes = [node]
            elif dist == min_dist and node['line'] == best_line:
                best_nodes.append(node)
                
    if not best_nodes:
        print(f"SyncTeX debug: No nodes found for target_line={target_line}", file=sys.stderr)
        return None
        
    print(f"SyncTeX debug: target_line={target_line}, best_line={best_line}, min_dist={min_dist}, num_nodes={len(best_nodes)}", file=sys.stderr)
    
    # Aggregate to find paragraph bounding box using ONLY text nodes ('h', 'x') to avoid glues ('g', 'k') expanding the box too much
    text_nodes = [n for n in best_nodes if n['type'] in ('h', 'x')]
    if not text_nodes:
        text_nodes = best_nodes # fallback if no text nodes
        
    
    
    # Group text nodes by page
    page_counts = {}
    for n in text_nodes:
        p = n['page']
        page_counts[p] = page_counts.get(p, 0) + 1
        
    # Find the page with the most nodes (the actual text, not ToC or headers)
    if not page_counts:
        return None
        
    best_page = max(page_counts.keys(), key=lambda k: page_counts[k])
    
    # Filter nodes to ONLY those on the best_page
    page_nodes = [n for n in text_nodes if n['page'] == best_page]
    
    # Filter out structural boxes by ensuring width > 20pt (actual text lines are wide)
    text_line_nodes = [n for n in page_nodes if n.get('w', 0) > 20]
    if not text_line_nodes:
        text_line_nodes = page_nodes

    # Use median Y to avoid outliers on this specific page
    y_values = sorted([n['y'] for n in text_line_nodes])
    if y_values:
        median_y = y_values[len(y_values) // 2]
        # Filter nodes that are roughly on the same paragraph
        valid_nodes = [n for n in text_line_nodes if abs(n['y'] - median_y) < 150]
        if not valid_nodes: valid_nodes = text_line_nodes
    else:
        valid_nodes = text_line_nodes
        
    min_y = min([n['y'] for n in valid_nodes], default=best_nodes[0]['y'])
    max_y = max([n['y'] for n in valid_nodes], default=best_nodes[0]['y'])
    min_x = min([n['x'] for n in valid_nodes], default=best_nodes[0]['x'])
    
    # print(f"SyncTeX coords: min_y={min_y}, max_y={max_y}, median_y={median_y}, min_x={min_x}", file=sys.stderr)
    
    # DEBUG ALL NODES on this page to see what they actually are
    # for i, n in enumerate(page_nodes):
    #     if i < 20: # print first 20 to avoid spam
    #         print(f"  Node {i}: type={n['type']}, line={n['line']}, x={n['x']:.1f}, y={n['y']:.1f}, w={n.get('w',0):.1f}, h={n.get('h',0):.1f}", file=sys.stderr)
        
    # Calculate height. We use max_y - min_y. If they are on the same line, height is fallback 12.
    # Note: y is usually baseline. Top is min_y - 10, Bottom is max_y + 2
    
    page = valid_nodes[0]['page'] if valid_nodes else best_nodes[0]['page']
    
    # Let's find the maximum width based on valid nodes
    max_right = max([n['x'] + (n.get('w', 0) or 0) for n in valid_nodes], default=min_x + 10)
    w = max_right - min_x
    
    # The height is the difference in baselines + an approximation for text height
    h = max_y - min_y + 12
    
    return {
        'page': page,
        'x': min_x,
        'y': min_y - 10, # Adjust y so the box starts ABOVE the baseline
        'w': w,
        'h': h
    }

def find_source_line(synctex_path, page, x, y):
    """Finds the source file and line closest to the PDF coordinates."""
    parser = SynctexParser(synctex_path)
    
    best_node = None
    min_dist = float('inf')
    
    for node in parser.nodes:
        if node['page'] == page:
            dx = node['x'] - x
            dy = node['y'] - y
            dist = dx*dx + (dy*dy * 4) # weight Y
            
            if dist < min_dist:
                min_dist = dist
                best_node = node
                
    if best_node and best_node['tag'] in parser.inputs:
        return {
            'file': parser.inputs[best_node['tag']],
            'line': best_node['line']
        }
    return None
